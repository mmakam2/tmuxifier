// Newest-first ordering shared by the persisted job managers (setup,
// provision, lifecycle). A valid total order: equal timestamps tie-break by
// id, so the result never depends on the sort algorithm's stability and
// same-instant jobs order deterministically.
export function newestFirst(a, b) {
  if (a.createdAt < b.createdAt) return 1;
  if (a.createdAt > b.createdAt) return -1;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}
