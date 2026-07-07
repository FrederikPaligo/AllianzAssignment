/**
 * Chain Handler v4.3
 *
 * Correct flow:
 *   1. User MANUALLY creates review for Group 1 - automation does NOT create this.
 *   2. When Group 1 acts, automation kicks in:
 *      - Approved -> create review for Group 2
 *      - Rejected -> create contribution for the original author (looked up via API)
 *   3. If author completes contribution -> create review for Group 1 again
 *   4. Approvals advance: Group 2 -> Group 3 -> Group 4 -> Complete (tag taxonomy)
 *   5. Rejections revert per config (rejectionTarget on each stage)
 *
 * v4 changes:
 *   - Assignment cleanup: delete all assignments for a document on chain completion
 *   - Taxonomy removal: strip "Staging for Release" tag when a new cycle starts
 *   - Audit logging: full assignment details logged before deletion
 * v4.1: Persistent audit logging to GitHub (audit-log.json)
 * v4.2: Fixed dedup window blocking cross-stage approvals
 * v4.3: Stateless recovery — recovers chain position from Paligo API after restarts.
 *        Duplicate guard — checks for existing assignments before creating new ones.
 *
 * State tracker stores per document:
 *   { stage: number | "author_revision", issuerId: number, issuerName: string, documentTitle: string }
 *
 *   stage meanings:
 *     undefined  = first event, Group 1 just acted (manual assignment)
 *     0          = Group 1 currently has a review (sent back by Group 2 rejection)
 *     1          = Group 2 currently has a review
 *     2          = Group 3 currently has a review
 *     3          = Group 4 currently has a review
 *     "author_revision" = original author has a contribution assignment
 */

const { getChainForPublication } = require("./config/chains");

class ChainHandler {
  constructor(paligoClient) {
    this.paligo = paligoClient;
    this._stageTracker = {};      // docId -> { stage, issuerId, issuerName, documentTitle }
    this._recentEvents = {};      // dedup
    this.DEDUP_WINDOW_MS = 30_000;
  }

  // --- Main entry point ---

  async handleEvent(webhookPayload) {
    const { event, data } = webhookPayload;

    if (event !== "ASSIGNMENT_USERSTATUS_CHANGED") {
      console.log(`[chain] Ignoring event type: ${event}`);
      return null;
    }

    const documentId = data.resource_id;
    const documentTitle = data.resource_title || "Unknown";
    const lang = data.language || "en";
    const status = data.status;

    console.log(`\n[chain] -- Event received --`);
    console.log(`[chain] Document: ${documentId} ("${documentTitle}")`);
    console.log(`[chain] Status: ${status}`);

    if (!status || !["approved", "rejected"].includes(status)) {
      console.log(`[chain] Unknown status: ${status} - skipping`);
      return null;
    }

    // Dedup
    const dedupKey = `${documentId}:${status}`;
    const now = Date.now();
    if (this._recentEvents[dedupKey] && (now - this._recentEvents[dedupKey]) < this.DEDUP_WINDOW_MS) {
      console.log(`[chain] Duplicate within ${this.DEDUP_WINDOW_MS / 1000}s - skipping`);
      return null;
    }
    this._recentEvents[dedupKey] = now;

    // Clean old dedup entries
    for (const key of Object.keys(this._recentEvents)) {
      if ((now - this._recentEvents[key]) > this.DEDUP_WINDOW_MS * 2) {
        delete this._recentEvents[key];
      }
    }

    const chain = getChainForPublication(String(documentId));
    let tracker = this._stageTracker[String(documentId)];

    // --- Recover tracker from API if missing (e.g. after restart/redeploy) ---
    if (!tracker) {
      tracker = await this._recoverTracker(chain, documentId, documentTitle);
      if (tracker) {
        this._stageTracker[String(documentId)] = tracker;
      }
    }

    // --- Route based on current state ---

    let result;

    // State: author has a contribution (waiting for author to finish)
    if (tracker && tracker.stage === "author_revision") {
      result = await this._handleAuthorResponse(chain, documentId, lang, status, tracker);
    }
    // State: no tracker = first event for this doc = Group 1 just acted
    else if (!tracker) {
      result = await this._handleFirstEvent(chain, documentId, documentTitle, lang, status);
    }
    // State: tracked stage 0-3 = that group just acted
    else {
      result = await this._handleStageResponse(chain, documentId, lang, status, tracker);
    }

    // If we successfully processed the event (advanced/reverted the chain),
    // clear the dedup entry so the NEXT stage's approval isn't blocked.
    if (result) {
      delete this._recentEvents[dedupKey];
    }

    return result;
  }

  // --- Recover tracker from Paligo API ---

  /**
   * When the in-memory tracker is missing (after a restart/redeploy),
   * fetch the document's assignments from Paligo and figure out which
   * stage the chain is at based on the most recent auto-created assignment.
   *
   * Returns a tracker object or null if this looks like a genuine first event.
   */
  async _recoverTracker(chain, documentId, documentTitle) {
    console.log(`[chain] No tracker for ${documentId} - attempting recovery from API`);

    try {
      const assignments = await this.paligo.getAssignmentsForDocument(documentId);

      if (assignments.length === 0) {
        console.log(`[chain] No assignments found - treating as first event`);
        return null;
      }

      // Find the most recent auto-created assignment (by our automation)
      const autoAssignment = assignments.find(a =>
        a.message && (
          a.message.startsWith("Auto-assigned:") ||
          a.message.startsWith("Returned for revision:") ||
          a.message.startsWith("Revision needed:")
        )
      );

      if (!autoAssignment) {
        // Only manual assignments exist -> this is genuinely Group 1 acting
        console.log(`[chain] Only manual assignments found - treating as first event`);
        return null;
      }

      // Determine stage from the auto-assignment's message
      const msg = autoAssignment.message;

      // Check for author revision
      if (msg.startsWith("Revision needed:")) {
        console.log(`[chain] Recovered: author_revision (from "${msg}")`);
        // Try to find the original issuer info
        const issuerInfo = await this.paligo.findOriginalIssuer(documentId);
        return {
          stage: "author_revision",
          issuerId: issuerInfo?.issuer_id,
          issuerName: issuerInfo?.issuer,
          documentTitle,
        };
      }

      // Check which chain stage matches
      for (let i = 0; i < chain.length; i++) {
        if (msg.includes(chain[i].label)) {
          console.log(`[chain] Recovered: stage ${i} (from "${msg}")`);
          return { stage: i, documentTitle };
        }
      }

      // If we found an auto-assignment but couldn't map it to a stage,
      // it might be from a completed/old chain. Treat as first event.
      console.log(`[chain] Could not map auto-assignment to a stage - treating as first event`);
      return null;

    } catch (err) {
      console.error(`[chain] Recovery failed:`, err.message);
      console.log(`[chain] Falling back to first-event handling`);
      return null;
    }
  }

  // --- Duplicate guard ---

  /**
   * Before creating an assignment, check if one already exists for this
   * document + target group. Returns true if a duplicate exists.
   */
  async _hasDuplicateAssignment(documentId, groupId) {
    try {
      const assignments = await this.paligo.getAssignmentsForDocument(documentId);
      const existing = assignments.find(a => {
        // Check if any assignment for this doc targets the same group
        // Assignment groups are in the assignees.groups array or can be
        // identified by the message containing the group's label
        if (a.groups && Array.isArray(a.groups)) {
          return a.groups.includes(groupId);
        }
        return false;
      });

      if (existing) {
        console.log(`[chain] Duplicate guard: assignment ${existing.id} already exists for group ${groupId} on doc ${documentId} - skipping`);
        return true;
      }
    } catch (err) {
      console.error(`[chain] Duplicate check failed:`, err.message, `- proceeding anyway`);
    }
    return false;
  }

  // --- First event: Group 1 just acted on the manual assignment ---

  async _handleFirstEvent(chain, documentId, documentTitle, lang, status) {
    const key = String(documentId);

    // Remove leftover taxonomy from a previous cycle (e.g. "Staging for Release")
    if (chain.completionTaxonomyId) {
      try {
        await this.paligo.removeTaxonomyFromDocument(documentId, chain.completionTaxonomyId);
      } catch (err) {
        console.error(`[chain] Taxonomy removal failed:`, err.message);
      }
    }

    if (status === "approved") {
      // Group 1 approved -> create review for Group 2 (stage index 1)
      const nextStage = chain[1];
      if (!nextStage) {
        console.log(`[chain] Chain has no stage 1 - complete`);
        return null;
      }

      console.log(`[chain] Group 1 APPROVED -> creating review for ${nextStage.label}`);

      const result = await this.paligo.createAssignment({
        documentId,
        groupId: nextStage.groupId,
        label: nextStage.label,
        deadline: nextStage.deadline,
        type: "review",
        lang,
        message: `Auto-assigned: ${nextStage.label} (Stage 2 of ${chain.length})`,
      });

      this._stageTracker[key] = { stage: 1, documentTitle };
      return { action: "stage_advanced", stage: 1, label: nextStage.label, result };
    }

    // Group 1 rejected -> contribution to original author
    console.log(`[chain] Group 1 REJECTED -> looking up original author`);

    const issuerInfo = await this.paligo.findOriginalIssuer(documentId);
    if (!issuerInfo) {
      console.error(`[chain] Cannot find original issuer - cannot create contribution`);
      return null;
    }

    console.log(`[chain] Creating contribution for ${issuerInfo.issuer} (ID: ${issuerInfo.issuer_id})`);

    const result = await this.paligo.createAssignment({
      documentId,
      userId: issuerInfo.issuer_id,
      type: "contribution",
      label: "Author Revision",
      deadline: 30,
      lang,
      message: `Revision needed: Rejected by ${chain[0].label} - please revise and resubmit`,
    });

    this._stageTracker[key] = {
      stage: "author_revision",
      issuerId: issuerInfo.issuer_id,
      issuerName: issuerInfo.issuer,
      documentTitle,
    };

    return { action: "rejected_to_author", issuer: issuerInfo.issuer, result };
  }

  // --- Author finished their contribution ---

  async _handleAuthorResponse(chain, documentId, lang, status, tracker) {
    const key = String(documentId);

    if (status === "approved") {
      // Author completed contribution -> send back to Group 1 for review
      const group1 = chain[0];
      console.log(`[chain] Author completed revision -> creating review for ${group1.label}`);

      const result = await this.paligo.createAssignment({
        documentId,
        groupId: group1.groupId,
        label: group1.label,
        deadline: group1.deadline,
        type: "review",
        lang,
        message: `Auto-assigned: ${group1.label} - author has revised, please re-review`,
      });

      this._stageTracker[key] = {
        stage: 0,
        issuerId: tracker.issuerId,
        issuerName: tracker.issuerName,
      };

      return { action: "author_done_back_to_group1", label: group1.label, result };
    }

    // Author rejected their own contribution? Unlikely, but ignore.
    console.log(`[chain] Author rejected contribution - ignoring`);
    return null;
  }

  // --- A tracked stage (0-3) just responded ---

  async _handleStageResponse(chain, documentId, lang, status, tracker) {
    const key = String(documentId);
    const currentStage = tracker.stage;
    const currentConfig = chain[currentStage];

    if (status === "approved") {
      const nextStageIndex = currentStage + 1;

      // Chain complete?
      if (nextStageIndex >= chain.length) {
        console.log(`[chain] Chain COMPLETE for document ${documentId}!`);

        if (chain.completionTaxonomyId) {
          console.log(`[chain] Tagging with taxonomy ${chain.completionTaxonomyId}`);
          try {
            await this.paligo.addTaxonomyToDocument(documentId, chain.completionTaxonomyId);
            console.log(`[chain] Taxonomy tagged`);
          } catch (err) {
            console.error(`[chain] Taxonomy tagging failed:`, err.message);
          }
        }

        // Clean up all assignments for this document
        try {
          await this.paligo.deleteAssignmentsForDocument(documentId, tracker.documentTitle);
          console.log(`[chain] Assignments cleaned up`);
        } catch (err) {
          console.error(`[chain] Assignment cleanup failed:`, err.message);
        }

        delete this._stageTracker[key];
        return { action: "chain_complete", documentId, taxonomyTagged: !!chain.completionTaxonomyId };
      }

      // Advance to next stage
      const nextStage = chain[nextStageIndex];
      console.log(`[chain] ${currentConfig.label} APPROVED -> creating ${nextStage.label}`);

      const result = await this.paligo.createAssignment({
        documentId,
        groupId: nextStage.groupId,
        label: nextStage.label,
        deadline: nextStage.deadline,
        type: "review",
        lang,
        message: `Auto-assigned: ${nextStage.label} (Stage ${nextStageIndex + 1} of ${chain.length})`,
      });

      this._stageTracker[key] = { ...tracker, stage: nextStageIndex };
      return { action: "stage_advanced", stage: nextStageIndex, label: nextStage.label, result };
    }

    // --- Rejection ---

    const rejectionTarget = currentConfig.rejectionTarget;

    if (rejectionTarget === undefined) {
      console.log(`[chain] ${currentConfig.label} rejected but no rejectionTarget - ignoring`);
      return null;
    }

    // Special case: reject back to original author
    if (rejectionTarget === "author") {
      console.log(`[chain] ${currentConfig.label} REJECTED -> contribution to original author`);

      let issuerId = tracker.issuerId;
      let issuerName = tracker.issuerName;

      // Look up issuer if we don't have it cached
      if (!issuerId) {
        const issuerInfo = await this.paligo.findOriginalIssuer(documentId);
        if (!issuerInfo) {
          console.error(`[chain] Cannot find original issuer`);
          return null;
        }
        issuerId = issuerInfo.issuer_id;
        issuerName = issuerInfo.issuer;
      }

      const result = await this.paligo.createAssignment({
        documentId,
        userId: issuerId,
        type: "contribution",
        label: "Author Revision",
        deadline: 30,
        lang,
        message: `Revision needed: Rejected by ${currentConfig.label} - please revise and resubmit`,
      });

      this._stageTracker[key] = {
        stage: "author_revision",
        issuerId,
        issuerName,
      };

      return { action: "rejected_to_author", from: currentStage, issuer: issuerName, result };
    }

    // Normal rejection: revert to a specific stage
    const targetStage = chain[rejectionTarget];
    if (!targetStage) {
      console.error(`[chain] Invalid rejectionTarget ${rejectionTarget}`);
      return null;
    }

    console.log(`[chain] ${currentConfig.label} REJECTED -> reverting to ${targetStage.label}`);

    const result = await this.paligo.createAssignment({
      documentId,
      groupId: targetStage.groupId,
      label: targetStage.label,
      deadline: targetStage.deadline,
      type: "review",
      lang,
      message: `Returned for revision: ${targetStage.label} (sent back by ${currentConfig.label})`,
    });

    this._stageTracker[key] = { ...tracker, stage: rejectionTarget };
    return { action: "rejected_reverted", from: currentStage, to: rejectionTarget, label: targetStage.label, result };
  }

  resetTracking(documentId) {
    delete this._stageTracker[String(documentId)];
  }
}

module.exports = ChainHandler;
