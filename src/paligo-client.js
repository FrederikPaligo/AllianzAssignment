/**
 * Paligo REST API Client
 *
 * Handles authentication, assignment creation/deletion, taxonomy tagging,
 * looking up the original issuer of an assignment, and persistent audit
 * logging to GitHub.
 */

const axios = require("axios");

class PaligoClient {
  constructor({ instance, email, apiKey }) {
    this.baseUrl = `https://${instance}.paligoapp.com/api/v2`;
    this.auth = {
      username: email,
      password: apiKey,
    };
  }

  /**
   * Create an assignment for a document.
   *
   * Can assign to a GROUP or a specific USER:
   *   - For group: pass groupId
   *   - For user:  pass userId
   *
   * @param {Object} opts
   * @param {number} opts.documentId
   * @param {number} [opts.groupId]   - Usergroup ID (for review assignments)
   * @param {number} [opts.userId]    - User ID (for contribution assignments to original author)
   * @param {string} opts.type        - "review" or "contribution"
   * @param {string} opts.label       - Human-readable name (for logging)
   * @param {number} opts.deadline    - Days from now
   * @param {string} opts.lang
   * @param {string} opts.message
   */
  async createAssignment({ documentId, groupId, userId, type = "review", label, deadline, message, lang = "en" }) {
    const now = Math.floor(Date.now() / 1000);
    const endDate = deadline
      ? now + deadline * 24 * 60 * 60
      : now + 7 * 24 * 60 * 60;

    const assignees = {
      users: userId ? [userId] : [],
      groups: groupId ? [groupId] : [],
    };

    const payload = {
      assignees,
      document: documentId,
      type,
      lang,
      start_date: now,
      end_date: endDate,
      ...(message && { message }),
    };

    const target = userId ? `user ${userId}` : `group ${groupId}`;
    console.log(`[paligo] Creating ${type} assignment: "${label}" for document ${documentId} -> ${target}`);
    console.log(`[paligo]   Deadline: ${new Date(endDate * 1000).toISOString().split("T")[0]}`);

    try {
      const response = await axios.post(
        `${this.baseUrl}/assignments/`,
        payload,
        { auth: this.auth }
      );
      console.log(`[paligo] Assignment created successfully (ID: ${response.data.id})`);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const detail = error.response?.data || error.message;
      console.error(`[paligo] Failed to create assignment (HTTP ${status}):`, detail);
      throw new Error(`Paligo API error (${status}): ${JSON.stringify(detail)}`);
    }
  }

  /**
   * Delete a single assignment by ID.
   */
  async deleteAssignment(assignmentId) {
    console.log(`[paligo] Deleting assignment ${assignmentId}`);
    try {
      await axios.delete(
        `${this.baseUrl}/assignments/${assignmentId}/`,
        { auth: this.auth }
      );
      console.log(`[paligo] Assignment ${assignmentId} deleted`);
    } catch (error) {
      const status = error.response?.status;
      console.error(`[paligo] Delete failed (${status}):`, error.response?.data || error.message);
    }
  }

  /**
   * Delete all assignments for a specific document.
   *
   * IMPORTANT: Before deleting, we log the full audit trail for each
   * assignment (who created it, who was assigned, when, outcome).
   * This is critical because Paligo has no separate audit log,
   * so once assignments are deleted that history is gone from the UI.
   *
   * The audit data is logged to stdout AND persisted to GitHub (audit-log.json).
   */
  async deleteAssignmentsForDocument(documentId, documentTitle) {
    console.log(`[paligo] Cleaning up assignments for document ${documentId}`);

    const allAssignments = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const resp = await axios.get(
        `${this.baseUrl}/assignments/?page=${page}`,
        { auth: this.auth }
      );
      allAssignments.push(...resp.data.assignments);
      totalPages = resp.data.total_pages;
      page++;
    }

    const docAssignments = allAssignments.filter(a => a.document_id === documentId);

    if (docAssignments.length === 0) {
      console.log(`[paligo] No assignments found for document ${documentId}`);
      return;
    }

    // Log audit trail before deleting
    console.log(`[audit] ========================================`);
    console.log(`[audit] ASSIGNMENT AUDIT LOG - Document ${documentId}`);
    console.log(`[audit] Timestamp: ${new Date().toISOString()}`);
    console.log(`[audit] Total assignments to delete: ${docAssignments.length}`);
    console.log(`[audit] ----------------------------------------`);
    for (const a of docAssignments) {
      console.log(`[audit] Assignment ID: ${a.id}`);
      console.log(`[audit]   Type: ${a.type}`);
      console.log(`[audit]   Issuer: ${a.issuer} (ID: ${a.issuer_id})`);
      console.log(`[audit]   Created: ${new Date(a.created_at * 1000).toISOString()}`);
      console.log(`[audit]   Message: ${a.message || "(none)"}`);
      console.log(`[audit]   Status: ${JSON.stringify(a.user_statuses || [])}`);
      console.log(`[audit] ----------------------------------------`);
    }
    console.log(`[audit] ========================================`);

    // Persist to GitHub
    await this.logAuditToGitHub(documentId, documentTitle || "Unknown", docAssignments);

    // Now delete
    for (const a of docAssignments) {
      await this.deleteAssignment(a.id);
    }

    console.log(`[paligo] Deleted ${docAssignments.length} assignments for document ${documentId}`);
  }

  /**
   * Find the original (first manual) assignment for a document.
   * Returns { issuer, issuer_id } of whoever created the first assignment.
   *
   * We identify it as the earliest assignment for the document that
   * was NOT created by our automation (no "Auto-assigned:" prefix).
   */
  async findOriginalIssuer(documentId) {
    console.log(`[paligo] Looking up original issuer for document ${documentId}`);

    const allAssignments = [];
    let page = 1;
    let totalPages = 1;

    // Fetch all pages of assignments
    while (page <= totalPages) {
      const response = await axios.get(
        `${this.baseUrl}/assignments/?page=${page}`,
        { auth: this.auth }
      );
      allAssignments.push(...response.data.assignments);
      totalPages = response.data.total_pages;
      page++;
    }

    // Filter to this document, exclude auto-created ones, sort by created_at
    const manualAssignments = allAssignments
      .filter(a => a.document_id === documentId)
      .filter(a => !a.message || !a.message.startsWith("Auto-assigned:"))
      .filter(a => !a.message || !a.message.startsWith("Revision needed:"))
      .filter(a => !a.message || !a.message.startsWith("Returned for revision:"))
      .sort((a, b) => a.created_at - b.created_at);

    if (manualAssignments.length > 0) {
      const original = manualAssignments[0];
      console.log(`[paligo] Original issuer: ${original.issuer} (ID: ${original.issuer_id})`);
      return { issuer: original.issuer, issuer_id: original.issuer_id };
    }

    // Fallback: use the earliest assignment for this document
    const docAssignments = allAssignments
      .filter(a => a.document_id === documentId)
      .sort((a, b) => a.created_at - b.created_at);

    if (docAssignments.length > 0) {
      const first = docAssignments[0];
      console.log(`[paligo] Fallback issuer: ${first.issuer} (ID: ${first.issuer_id})`);
      return { issuer: first.issuer, issuer_id: first.issuer_id };
    }

    console.error(`[paligo] No assignments found for document ${documentId}`);
    return null;
  }

  /**
   * Add a taxonomy to a document.
   * Documents in "Released" or "In Review" status must be unlocked first.
   */
  async addTaxonomyToDocument(documentId, taxonomyId) {
    console.log(`[paligo] Adding taxonomy ${taxonomyId} to document ${documentId}`);

    const doc = await axios.get(
      `${this.baseUrl}/documents/${documentId}/`,
      { auth: this.auth }
    );

    const currentTaxonomies = (doc.data.taxonomies || []).map(t => t.id);
    if (currentTaxonomies.includes(taxonomyId)) {
      console.log(`[paligo] Taxonomy already present - skipping`);
      return doc.data;
    }

    const newTaxonomies = [...currentTaxonomies, taxonomyId];

    // Unlock document first
    await axios.put(
      `${this.baseUrl}/documents/${documentId}/`,
      { release_status: "STATUS_NOT_RELEASED" },
      { auth: this.auth }
    );

    const updated = await axios.put(
      `${this.baseUrl}/documents/${documentId}/`,
      { taxonomies: newTaxonomies },
      { auth: this.auth }
    );

    console.log(`[paligo] Taxonomy added successfully`);
    return updated.data;
  }

  /**
   * Remove a taxonomy from a document.
   * Used to clear the "Staging for Release" tag when a new review cycle starts.
   */
  async removeTaxonomyFromDocument(documentId, taxonomyId) {
    console.log(`[paligo] Removing taxonomy ${taxonomyId} from document ${documentId}`);

    const doc = await axios.get(
      `${this.baseUrl}/documents/${documentId}/`,
      { auth: this.auth }
    );

    const currentTaxonomies = (doc.data.taxonomies || []).map(t => t.id);
    if (!currentTaxonomies.includes(taxonomyId)) {
      console.log(`[paligo] Taxonomy not present - skipping`);
      return doc.data;
    }

    const updatedTaxonomies = currentTaxonomies.filter(id => id !== taxonomyId);

    // Unlock document first
    await axios.put(
      `${this.baseUrl}/documents/${documentId}/`,
      { release_status: "STATUS_NOT_RELEASED" },
      { auth: this.auth }
    );

    const result = await axios.put(
      `${this.baseUrl}/documents/${documentId}/`,
      { taxonomies: updatedTaxonomies },
      { auth: this.auth }
    );

    console.log(`[paligo] Taxonomy removed successfully`);
    return result.data;
  }

  /**
   * Log audit trail to a JSON file in the GitHub repo.
   *
   * Reads the existing audit-log.json, appends the new entry, and commits.
   * If the file doesn't exist yet, it creates it.
   *
   * Requires env vars: GITHUB_TOKEN, GITHUB_REPO (e.g. "FrederikPaligo/Assignments")
   */
  async logAuditToGitHub(documentId, documentTitle, assignments) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;

    if (!token || !repo) {
      console.log(`[audit] GitHub logging skipped (GITHUB_TOKEN or GITHUB_REPO not set)`);
      return;
    }

    const filePath = "audit-log.json";
    const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "paligo-review-chain",
    };

    // Build the new audit entry
    const entry = {
      timestamp: new Date().toISOString(),
      documentId,
      documentTitle,
      assignmentsDeleted: assignments.map(a => ({
        id: a.id,
        type: a.type,
        issuer: a.issuer,
        issuerId: a.issuer_id,
        created: new Date(a.created_at * 1000).toISOString(),
        message: a.message || null,
        userStatuses: a.user_statuses || [],
      })),
    };

    try {
      // Try to get the existing file
      let existingEntries = [];
      let sha = null;

      try {
        const existing = await axios.get(apiBase, { headers });
        sha = existing.data.sha;
        const content = Buffer.from(existing.data.content, "base64").toString("utf-8");
        existingEntries = JSON.parse(content);
      } catch (err) {
        if (err.response?.status === 404) {
          console.log(`[audit] audit-log.json not found in repo, creating it`);
        } else {
          throw err;
        }
      }

      // Append new entry
      existingEntries.push(entry);

      // Commit updated file
      const updatedContent = Buffer.from(
        JSON.stringify(existingEntries, null, 2)
      ).toString("base64");

      const commitPayload = {
        message: `audit: document ${documentId} - ${assignments.length} assignment(s) deleted`,
        content: updatedContent,
        ...(sha && { sha }),
      };

      await axios.put(apiBase, commitPayload, { headers });
      console.log(`[audit] Audit entry committed to GitHub (${existingEntries.length} total entries)`);
    } catch (err) {
      // Non-fatal: log the error but don't break the workflow
      console.error(`[audit] GitHub logging failed:`, err.response?.data?.message || err.message);
      console.error(`[audit] Audit data was still logged to stdout above`);
    }
  }

  async listGroups() {
    const response = await axios.get(`${this.baseUrl}/groups`, { auth: this.auth });
    return response.data;
  }
}

module.exports = PaligoClient;
