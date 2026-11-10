// The one way the app page talks to the team sheet (bridge/Code.gs). Contract: docs/product-contract.md.
import { getTeam } from './team.js'

export async function bridge(action, body = {}) {
  const team = await getTeam()
  if (!team) throw new Error('Join your team first: Team sheet in the sidebar')
  const response = await fetch(team.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ token: team.token, action, ...body }) })
  if (!response.ok) throw new Error(`The team sheet answered HTTP ${response.status}`)
  const reply = await response.json().catch(() => { throw new Error('The team sheet sent an unreadable reply (is the web app deployed for "Anyone"?)') })
  if (reply.ok === false || reply.error) throw new Error(reply.error || 'The team sheet refused the request')
  return reply
}
