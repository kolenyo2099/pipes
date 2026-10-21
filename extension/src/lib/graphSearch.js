export function searchGraphNodes(nodes, query, limit = 8) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []

  return nodes
    .map(node => {
      const name = node.name.toLocaleLowerCase()
      const rank = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : -1
      return { node, rank }
    })
    .filter(result => result.rank >= 0)
    .sort((a, b) =>
      a.rank - b.rank
      || b.node.count - a.node.count
      || a.node.name.localeCompare(b.node.name)
    )
    .slice(0, limit)
    .map(result => result.node)
}
