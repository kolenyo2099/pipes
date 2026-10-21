// Telegram's user API runs directly in the extension's offscreen document over WSS.
// The browser-native MTProto client and its session stay local to this Chrome profile;
// neither is sent to a Canary server or included in project backups.
import { getSetting, setSetting, deleteSetting } from './db.js'
import { hash } from './ontology.js'

export const TELEGRAM_API_ACCOUNT = 'telegram_api_account'

let pending = null
let libraryPromise = null

const library = () => {
  if (!libraryPromise) {
    const loader = globalThis.MTGoWasmLoader
    libraryPromise = (loader?.load ? loader.load('/vendor/mtgo-wasm.wasm.gz') : Promise.reject(new Error('Telegram’s local client is unavailable. Reload the Canary extension and try again.')))
      .then(client => {
        if (!client?.createClient) throw new Error('Telegram’s local client did not start. Reload the Canary extension and try again.')
        return client
      })
      .catch(error => {
        libraryPromise = null
        throw error
      })
  }
  return libraryPromise
}

const errorMessage = error => String(error?.message || error || 'Telegram connection failed')
const displayName = user => user?.username ? `@${user.username}` : [user?.first_name, user?.last_name, user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Telegram account'
const normalizePhone = phone => String(phone || '').replace(/[\s()-]/g, '')

async function clientFor(account, callbacks = {}) {
  const mtgo = await library()
  return mtgo.createClient({
    apiID: Number(account.api_id), apiHash: account.api_hash, timeout: 60,
    ...(account.session ? { sessionString: account.session } : { manualAuth: true }),
    ...callbacks,
  })
}

async function close(client) {
  try { await client?.disconnect() } catch { /* a closed WebSocket needs no cleanup */ }
}

async function saveAccount(client, account, user) {
  const session = await client.sessionString()
  if (!session) throw new Error('Telegram did not return a reusable local session')
  const saved = {
    api_id: Number(account.api_id), api_hash: account.api_hash, phone: account.phone,
    session, handle: displayName(user), connected_at: new Date().toISOString(),
  }
  await setSetting(TELEGRAM_API_ACCOUNT, saved)
  return { connected: true, handle: saved.handle }
}

export async function telegramApiConfigured() {
  const account = await getSetting(TELEGRAM_API_ACCOUNT)
  return !!account?.session
}

export async function telegramApiStatus() {
  const account = await getSetting(TELEGRAM_API_ACCOUNT)
  return { connected: !!account?.session, handle: account?.handle || null, pending: pending?.stage || null }
}

export async function beginTelegramConnect({ apiId, apiHash, phone }) {
  if (pending) throw new Error('Finish or cancel the Telegram connection already in progress')
  const account = { api_id: Number(apiId), api_hash: String(apiHash || '').trim(), phone: normalizePhone(phone) }
  if (!Number.isInteger(account.api_id) || account.api_id <= 0 || !account.api_hash || !account.phone) {
    throw new Error('Enter an API ID, API hash, and phone number')
  }
  const flow = { account, client: null, stage: 'connecting', phone_code_hash: null }
  pending = flow
  try {
    flow.client = await clientFor(account)
    await flow.client.connect()
    const sent = await flow.client.sendCode(account.phone)
    flow.phone_code_hash = sent.phone_code_hash
    flow.stage = 'code'
    return { stage: 'code', delivery: 'your Telegram app or phone' }
  } catch (error) {
    if (pending === flow) pending = null
    await close(flow.client)
    throw new Error(errorMessage(error))
  }
}

export async function finishTelegramCode(code) {
  if (!pending || pending.stage !== 'code') throw new Error('Telegram is not waiting for a sign-in code')
  const value = String(code || '').trim()
  if (!value) throw new Error('Enter the code Telegram sent')
  try {
    const user = await pending.client.signIn(pending.account.phone, pending.phone_code_hash, value)
    const connected = await saveAccount(pending.client, pending.account, user)
    await close(pending.client)
    pending = null
    return { stage: 'connected', ...connected }
  } catch (error) {
    if (/2FA is enabled|SESSION_PASSWORD_NEEDED/i.test(errorMessage(error))) {
      pending.stage = 'password'
      return { stage: 'password' }
    }
    throw new Error(errorMessage(error))
  }
}

export async function finishTelegramPassword(password) {
  if (!pending || pending.stage !== 'password') throw new Error('Telegram is not waiting for a 2-step verification password')
  const value = String(password || '')
  if (!value) throw new Error('Enter the 2-step verification password')
  try {
    const user = await pending.client.checkPassword(value)
    const connected = await saveAccount(pending.client, pending.account, user)
    await close(pending.client)
    pending = null
    return { stage: 'connected', ...connected }
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

export async function cancelTelegramConnect() {
  const flow = pending
  pending = null
  await close(flow?.client)
  return { cancelled: true }
}

export async function clearTelegramAccount() {
  await cancelTelegramConnect()
  await deleteSetting(TELEGRAM_API_ACCOUNT)
  return { connected: false }
}

function text(message) { return String(message?.message || '').trim() || '(media without text)' }
function date(message) {
  const value = Number(message?.date)
  const milliseconds = Number.isFinite(value) && value > 0 ? (value < 1_000_000_000_000 ? value * 1000 : value) : Date.now()
  return new Date(milliseconds).toISOString()
}
function forwardedFrom(message) { return message?.fwd_from?.from_name || message?.fwdFrom?.fromName || message?.fwdFrom?.from?.username || null }

export function telegramApiItems(messages, project, rule, channel) {
  return messages.filter(message => Number.isInteger(message?.id)).map(message => {
    const id = `${channel}/${message.id}`
    const forwarded = forwardedFrom(message)
    return {
      item_id: hash([project.project_id, 'telegram', id]), project_id: project.project_id, source_type: 'telegram',
      gdelt_primary_id: id, datetime_utc: date(message), countries_focus: project.countries_focus, query_bucket: rule.bucket_name,
      title_or_summary: text(message), url: `https://t.me/${channel}/${message.id}`,
      snippet_or_context: forwarded ? `Forwarded from ${forwarded}` : null,
      normalized: {
        lane: 'telegram', source_name: `@${channel}`, author_name: message?.post_author || message?.postAuthor || null,
        query_text: `@${channel}`, forwarded_from: forwarded, links: [], view_count: Number.isFinite(message?.views) ? message.views : null,
      },
      gdelt_raw: null,
    }
  })
}

export async function telegramApiPage(project, rule, { channel }, hole) {
  const account = await getSetting(TELEGRAM_API_ACCOUNT)
  if (!account?.session) return { error: 'connect a Telegram account in the Telegram rule editor', stop: true }
  let client
  try {
    client = await clientFor(account)
    await client.connect()
    const messages = await client.channelHistory(channel, Number(hole.next) || 0, 100)
    const items = telegramApiItems(messages, project, rule, channel)
    const oldest = items.length ? Math.min(...items.map(item => Number(item.gdelt_primary_id.split('/')[1]))) : 0
    return { items, next: oldest || null, done: !oldest }
  } catch (error) {
    const message = errorMessage(error)
    return { error: message, stop: /AUTH|SESSION_REVOKED|USER_DEACTIVATED|UNAUTHORIZED/.test(message) }
  } finally {
    await close(client)
  }
}

export async function telegramApiRequest(operation, payload = {}) {
  if (operation === 'status') return telegramApiStatus()
  if (operation === 'begin') return beginTelegramConnect(payload)
  if (operation === 'code') return finishTelegramCode(payload.code)
  if (operation === 'password') return finishTelegramPassword(payload.password)
  if (operation === 'cancel') return cancelTelegramConnect()
  if (operation === 'clear') return clearTelegramAccount()
  throw new Error('Unknown Telegram connection request')
}
