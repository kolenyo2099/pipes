// Background collector: the service worker wakes this document on each alarm tick and for "Run now".
// It lives here because service workers cannot start the Web Worker that parses GDELT files.
import { collectDue, runProjectNow } from './backend/collect.js'
import { configureNlp } from './backend/nlp.js'
import { telegramApiRequest } from './backend/telegram-api.js'

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.target !== 'offscreen') return
  if (message.type === 'nlp') {
    configureNlp(message.operation).then(result => reply({ result }), error => reply({ error: error.message || String(error) }))
    return true
  }
  if (message.type === 'telegram-api') {
    telegramApiRequest(message.operation, message.payload).then(result => reply({ result }), error => reply({ error: error.message || String(error) }))
    return true
  }
  if (message.type === 'tick') {
    // Replying makes the service worker able to distinguish a live collector
    // from a message with no receiving context. Collection itself remains
    // asynchronous so the alarm does not wait for every lane to finish.
    collectDue().then(() => reply(true), error => {
      console.error('Canary scheduled collection failed:', error)
      reply(false)
    })
    return true
  }
  if (message.type === 'run-now') {
    runProjectNow(message.projectId).then(reply, error => {
      console.error('Canary manual collection failed:', error)
      reply(false)
    })
    return true
  }
})
