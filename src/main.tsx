import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

if (window.slackDesktop) {
  document.documentElement.classList.add('desktop', `desktop-${window.slackDesktop.platform}`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
