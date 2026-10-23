/**
 * Auth / API-key isolation regression tests (mission 4, item 11).
 *
 * Owner-reported bug: "logging in on the login page saves the username
 * as API Key and the password as Secret Key in the settings page,
 * replacing previous values." Code audit says the two live in SEPARATE
 * storage keys:
 *   - login()            → automationState:auth_credentials   (STORAGE_KEYS.authCredentials)
 *   - saveAccountSettings→ automationState:settings_apiKeys   (STORAGE_KEYS.accountSettings)
 * These tests PROVE the isolation end-to-end against a throwaway data
 * file: repeated/wrong logins can never read or overwrite the account
 * API keys, and saving account settings never touches credentials.
 *
 * Setup mode note: session.ts allows first-login bootstrap when
 * AUTH_ALLOW_SETUP=1 OR AUTH_SECRET is unset — in this test process
 * AUTH_SECRET is unset, so setup mode is active.
 * Run: bun run tests/auth-isolation.test.ts
 */

// Fresh data file per process — set BEFORE any storage import (dynamic
// imports below guarantee ordering; the adapter resolves the path lazily
// on first access anyway).
process.env.TB_DATA_FILE = `/tmp/tb-auth-test-${process.pid}.json`

import { promises as fs } from 'node:fs'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`✗ ${label}`)
  }
}

const { getStorage, STORAGE_KEYS } = await import('../src/server/storage')
const { login } = await import('../src/server/auth/session')
const { saveAccountSettings } = await import('../src/server/configuration/settings-service')

interface StoredAccount {
  apiKey?: string
  secretKey?: string
  baleToken?: string
  baleChatId?: string
}
interface StoredCredentials {
  username?: string
  passwordHash?: string
  salt?: string
  issuedAt?: number
}

async function main(): Promise<void> {
  await fs.rm(process.env.TB_DATA_FILE!, { force: true })
  const store = getStorage()

  /* ---- Test 1: fresh login writes ONLY auth_credentials ---- */

  const first = await login('myuser', 'mypass')
  assert(first.ok === true, 'Test 1: first login (setup mode) succeeds')

  const creds = await store.get<StoredCredentials>(STORAGE_KEYS.authCredentials)
  assert(creds !== null, 'Test 1: auth_credentials key exists after login')
  assert(creds?.username === 'myuser', 'Test 1: stored username is myuser')
  assert(typeof creds?.passwordHash === 'string' && creds!.passwordHash!.length > 0, 'Test 1: password stored HASHED (never plaintext)')
  assert(creds?.passwordHash !== 'mypass', 'Test 1: stored hash is not the raw password')

  const keys = await store.list()
  assert(!keys.includes(STORAGE_KEYS.accountSettings), `Test 1: NO settings_apiKeys key after fresh login (keys: ${keys.join(', ')})`)
  const accountEmpty = await store.get<StoredAccount>(STORAGE_KEYS.accountSettings)
  assert(accountEmpty === null, 'Test 1: get(settings_apiKeys) → null (login never created it)')

  /* ---- Test 2: saving API keys + re-login leaves BOTH intact ---- */

  await saveAccountSettings({ apiKey: 'REAL_KEY', secretKey: 'REAL_SECRET' })
  const saved = await store.get<StoredAccount>(STORAGE_KEYS.accountSettings)
  assert(saved?.apiKey === 'REAL_KEY', 'Test 2: saveAccountSettings stored apiKey REAL_KEY')
  assert(saved?.secretKey === 'REAL_SECRET', 'Test 2: saveAccountSettings stored secretKey REAL_SECRET')

  const again = await login('myuser', 'mypass')
  assert(again.ok === true, 'Test 2: re-login with the SAME credentials succeeds')

  const accountAfter = await store.get<StoredAccount>(STORAGE_KEYS.accountSettings)
  assert(accountAfter?.apiKey === 'REAL_KEY', 'Test 2: API key STILL REAL_KEY after re-login (login does not overwrite account keys)')
  assert(accountAfter?.secretKey === 'REAL_SECRET', 'Test 2: secret STILL REAL_SECRET after re-login')

  const credsAfter = await store.get<StoredCredentials>(STORAGE_KEYS.authCredentials)
  assert(credsAfter?.username === 'myuser', 'Test 2: auth username still myuser (account save does not overwrite credentials)')
  assert(credsAfter?.passwordHash === creds?.passwordHash, 'Test 2: password hash unchanged by the account-settings save')

  /* ---- Test 3: wrong password fails WITHOUT touching stored state ---- */

  const wrong = await login('myuser', 'WRONG_PASSWORD')
  assert(wrong.ok === false, 'Test 3: login with wrong password rejected')

  const accountFinal = await store.get<StoredAccount>(STORAGE_KEYS.accountSettings)
  assert(accountFinal?.apiKey === 'REAL_KEY', 'Test 3: API key unchanged after failed login')
  assert(accountFinal?.secretKey === 'REAL_SECRET', 'Test 3: secret unchanged after failed login')

  const credsFinal = await store.get<StoredCredentials>(STORAGE_KEYS.authCredentials)
  assert(credsFinal?.username === 'myuser', 'Test 3: credentials unchanged after failed login')
  assert(credsFinal?.passwordHash === creds?.passwordHash, 'Test 3: password hash unchanged after failed login')

  // Total write surface: exactly the two isolated keys, nothing else
  const finalKeys = (await store.list()).sort()
  const expectedKeys = [STORAGE_KEYS.accountSettings, STORAGE_KEYS.authCredentials].sort()
  assert(JSON.stringify(finalKeys) === JSON.stringify(expectedKeys), `Test 3: storage contains EXACTLY the two isolated keys (got ${finalKeys.join(', ')})`)
}

try {
  await main()
} catch (e) {
  fail++
  console.error(`✗ unexpected error: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await fs.rm(process.env.TB_DATA_FILE!, { force: true })
}

console.log(`auth-isolation: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
