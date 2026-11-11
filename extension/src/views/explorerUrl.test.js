import { expect, it } from 'vitest'
import { trustedExplorerUrl } from './explorerUrl.js'

it('trusts only https github.io explorer urls', () => {
  expect(trustedExplorerUrl('https://team.github.io/explorer/')).toBe(true)
  for (const bad of ['http://team.github.io/', 'https://evil.com/', 'https://github.io.evil.com/', 'https://evilgithub.io/', 'javascript:alert(1)', 'nope', ''])
    expect(trustedExplorerUrl(bad)).toBe(false)
})
