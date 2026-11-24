import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ExportWorker from './components/ExportWorker'
import { applyTheme, getStoredThemeId } from './config/themes'
import { SHOW_ENGINE_STATUS_BANNER } from './config/belrogProduct'
import { I18nProvider } from './i18n/I18nContext'
import './index.css'

const isExportWorker = typeof window !== 'undefined' && window.location.search.includes('export=worker')

// Upstream publishes a fixed, read-only provider-status banner here while their
// hosted engine consumes an account allowance. Belrog generates locally, so the
// banner is off (see config/belrogProduct.js) - it used to tell creators they
// needed "separate server activation", which is not true of this app.
const candidateBanner = SHOW_ENGINE_STATUS_BANNER && typeof window !== 'undefined' && window.electronAPI?.engineCandidateInfo
  ? (window.electronAPI?.engineCandidateInfo?.banner || 'Provider status unavailable')
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
