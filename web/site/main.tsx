// The website's entry: the CSP nonce for the styles its components add, then the app. See relay/src/site.ts.
import { setNonce } from 'get-nonce'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { store } from './store'

const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content
if (nonce) setNonce(nonce)

createRoot(document.getElementById('app') as HTMLElement).render(<App />)
void store.start()
