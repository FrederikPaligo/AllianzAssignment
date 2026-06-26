/**
 * Review Chain Configuration — Allianz Instance
 *
 * FLOW:
 *   1. User MANUALLY creates a review assignment for Group 1
 *   2. Automation kicks in after Group 1 acts:
 *      - Approved → auto-create review for Group 2
 *      - Rejected → auto-create contribution for the original author
 *   3. If author completes contribution → auto-create review for Group 1 again
 *   4. Chain continues: Group 2 → Group 3 → Group 4 → Complete
 *
 * Each stage:
 *   - groupId:          Paligo usergroup ID
 *   - label:            human-readable name
 *   - deadline:         days for the deadline
 *   - rejectionTarget:  stage INDEX to revert to, or "author" for contribution to original issuer
 *
 * Rejection rules:
 *   - Group 1 rejects → contribution assignment to the original author (issuer)
 *   - Group 2 rejects → review back to Group 1
 *   - Group 3 rejects → review back to Group 2
 *   - Group 4 rejects → review back to Group 2
 *
 * On completion (Group 4 approves): tag document with taxonomy 3062.
 */

const chains = {
  defaultChain: Object.assign(
    [
      {
        groupId: 1,
        label: "GAM Author Review",
        deadline: 30,
        rejectionTarget: "author",  // Reject → contribution to original author
      },
      {
        groupId: 2,
        label: "GAM Reviewer Review",
        deadline: 30,
        rejectionTarget: 0,         // Reject → back to Group 1
      },
      {
        groupId: 3,
        label: "GAM Approver Review",
        deadline: 30,
        rejectionTarget: 1,         // Reject → back to Group 2
      },
      {
        groupId: 4,
        label: "Auditor Review",
        deadline: 30,
        rejectionTarget: 1,         // Reject → back to Group 2
      },
    ],
    { completionTaxonomyId: 3062 }
  ),

  publicationOverrides: {},
};

function getChainForPublication(documentId) {
  return chains.publicationOverrides[String(documentId)] || chains.defaultChain;
}

module.exports = { chains, getChainForPublication };
