// Three-way comparison of one field: LGL value, VG value, and the value both systems last agreed on.
// Arguments are comparable forms; '' means empty. `agreed` is undefined when no agreed value exists yet.

export function compareField(lgl, vg, agreed) {
  if (agreed === undefined) return lgl === vg ? 'first-match' : 'never-agreed'
  if (lgl === agreed && vg === agreed) return 'same'
  if (lgl === vg) return 'converged'
  if (lgl === agreed) return vg === '' ? 'vg-cleared' : 'vg-changed'
  if (vg === agreed) return lgl === '' ? 'lgl-cleared' : 'lgl-changed'
  return 'both-changed'
}
