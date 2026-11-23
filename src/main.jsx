import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ExportWorker from './components/ExportWorker'
import { applyTheme, getStoredThemeId } from './config/themes'
import { I18nProvider } from './i18n/I18nContext'
import './index.css'

const isExportWorker = typeof window !== 'undefined' && window.location.search.includes('export=worker')

// Owner-metered engine test mode: the main process publishes one fixed,
// read-only banner string (never a live control surface) while the candidate
// engine consumes the existing allowance.
const candidateBanner = typeof window !== 'undefined'
  ? window.electronAPI?.engineCandidateInfo?.banner
  : null

applyTheme(getStoredThemeId())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      {candidateBanner ? (
        <div
          role="status"
          style={{
            background: 'rgba(245, 158, 11, 0.16)',
            borderBottom: '1px solid rgba(245, 158, 11, 0.45)',
            color: 'var(--foreground, #f59e0b)',
            padding: '6px 12px',
            fontSize: 12,
            textAlign: 'center',
          }}
        >
          {candidateBanner}
        </div>
      ) : null}
      {isExportWorker ? <ExportWorker /> : <App />}
    </I18nProvider>
  </React.StrictMode>,
)
