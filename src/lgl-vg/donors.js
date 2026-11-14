// Donor rule: who is a donor in LGL, and when they last gave.
// Ported from vg-utils/lgl-import/count.js on 2026-11-11; fund and payment-type ids are options, not constants.

const NON_COUNTING_GIFT_TYPE_IDS = new Set([7, 9, 15]) // Pledge, Soft Credit, Peer Credit

export function classifyDonors(constituents, gifts, { membershipFundId, paypalPaymentTypeId }) {
  const result = new Map()
  const byId = new Map()
  for (const c of constituents) {
    const entry = { isOrg: Boolean(c.is_org), count: 0, lastGiftDate: null }
    byId.set(c.id, entry)
    result.set(c.id, null)
  }

  for (const g of gifts) {
    const entry = byId.get(g.constituent_id)
    if (!entry) continue
    if (NON_COUNTING_GIFT_TYPE_IDS.has(g.gift_type_id)) continue
    if (g.fund_id === membershipFundId && g.payment_type_id === paypalPaymentTypeId) continue // dues
    entry.count++
    if (g.received_date && (entry.lastGiftDate === null || g.received_date > entry.lastGiftDate)) {
      entry.lastGiftDate = g.received_date
    }
  }

  for (const [id, e] of byId) {
    const isDonor = !e.isOrg && e.count > 0
    result.set(id, { isDonor, lastGiftDate: e.lastGiftDate })
  }
  return result
}
