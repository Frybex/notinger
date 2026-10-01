import { createRoot } from 'react-dom/client'
import App from './App'
import { isMac } from './lib/platform'
import './styles.css'

if (isMac) {
  document.documentElement.classList.add('is-mac')
}

const container = document.getElementById('root')

if (!container) {
  throw new Error('élément racine introuvable')
}

createRoot(container).render(<App />)
