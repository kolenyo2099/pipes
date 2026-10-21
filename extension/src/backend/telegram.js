// Telegram lane. Public channels have a web preview at t.me/s/<channel> that needs no sign-in: about twenty posts a
// page, older pages by ?before=<post number>. Telegram has no search across channels, so a rule lists channels; its
// keywords filter posts here, after the fetch, so a page without matches never stops a backfill early.
import { hash } from './ontology.js'

const CHANNEL = /^(?:@|(?:https?:\/\/)?(?:t|telegram)\.me\/(?:s\/)?)?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i
export const telegramChannel = entry => String(entry).trim().match(CHANNEL)?.[1] || null
export const telegramChannels = logic => [...new Set((logic?.telegram_accounts || []).map(telegramChannel).filter(Boolean))]
export const telegramUrl = (channel, before) => `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`

// Keywords are comma-separated; a post is kept when it contains any of them, ignoring case.
export const telegramKeywords = logic => String(logic?.telegram_query || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
export function telegramMatches(logic, item) {
  const keywords = telegramKeywords(logic)
  const text = `${item.title_or_summary}\n${item.snippet_or_context || ''}`.toLowerCase()
  return !keywords.length || keywords.some(keyword => text.includes(keyword))
}

// A page Canary cannot read means Telegram changed its format: the lane stops and asks the user to tell the developers.
const formatChanged = message => Object.assign(new Error(message), { formatChanged: true })
// textContent drops line breaks; keep them.
function textOf(element) {
  if (!element) return ''
  const copy = element.cloneNode(true)
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n')
  return copy.textContent.trim()
}
// "18.9M" views → 18900000
const count = text => { const m = String(text).trim().match(/^([\d.]+)([KM]?)$/i); return m ? Math.round(m[1] * { '': 1, K: 1e3, M: 1e6 }[m[2].toUpperCase()]) : null }

export function telegramItems(html, project, rule, channel) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const posts = [...doc.querySelectorAll('.tgme_widget_message[data-post]')]
  // A page past a channel's first post still has the channel header.
  if (!posts.length && !doc.querySelector('.tgme_channel_info')) throw formatChanged('Telegram channel page has neither posts nor a channel header')
  const items = []
  for (const post of posts) {
    if (post.classList.contains('service_message')) continue // "channel created" and the like
    const id = post.getAttribute('data-post')
    const time = post.querySelector('.tgme_widget_message_date time[datetime]')?.getAttribute('datetime')
    if (!/^\w+\/\d+$/.test(id) || !time) throw formatChanged(`Telegram post is missing its ${time ? 'number' : 'time'}`)
    const textElement = post.querySelector('.tgme_widget_message_text')
    const forwarded = post.querySelector('.tgme_widget_message_forwarded_from_name')
    items.push({
      item_id: hash([project.project_id, 'telegram', id]), project_id: project.project_id, source_type: 'telegram',
      gdelt_primary_id: id, datetime_utc: new Date(time).toISOString(),
      countries_focus: project.countries_focus, query_bucket: rule.bucket_name,
      title_or_summary: textOf(textElement) || '(media without text)',
      url: `https://t.me/${id}`,
      snippet_or_context: forwarded ? `Forwarded from ${textOf(forwarded)}` : null,
      normalized: {
        lane: 'telegram', source_name: `@${id.split('/')[0]}`, author_name: textOf(post.querySelector('.tgme_widget_message_owner_name')) || null,
        query_text: `@${channel}`, forwarded_from: forwarded?.getAttribute('href') || null,
        links: [...(textElement?.querySelectorAll('a[href^="http"]') || [])].map(a => a.getAttribute('href')).filter(href => !href.startsWith('https://t.me/')),
        view_count: count(post.querySelector('.tgme_widget_message_views')?.textContent),
      },
      gdelt_raw: null,
    })
  }
  // The next page holds posts before the oldest number on this one; past post 1 there is nothing left.
  const oldest = posts.length ? Math.min(...posts.map(post => Number(post.getAttribute('data-post').split('/')[1]))) : 0
  return { items, next: oldest > 1 ? oldest : null }
}
