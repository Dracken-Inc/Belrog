export const LANGUAGE_STORAGE_KEY = 'belrog-language'
// Builds before the product was named Belrog wrote the choice under this key.
// Upgraded installs have to keep their language, so it stays readable forever;
// only the new key is ever written.
export const LEGACY_LANGUAGE_STORAGE_KEYS = ['velorn-language']

export function readStoredLanguage(storage) {
  for (const key of [LANGUAGE_STORAGE_KEY, ...LEGACY_LANGUAGE_STORAGE_KEYS]) {
    try {
      const value = storage?.getItem?.(key)
      if (value) return value
    } catch (_) {
      // Storage can be unavailable in restricted browser contexts.
    }
  }
  return null
}
export const DEFAULT_LANGUAGE = 'en'

export function normalizeLocale(locale) {
  const value = String(locale || '').trim().toLowerCase().replace(/_/g, '-')
  if (!value) return DEFAULT_LANGUAGE
  if (value === 'jp' || value.startsWith('ja-')) return 'ja'
  return value.split('-')[0] || DEFAULT_LANGUAGE
}

export function resolveLanguage(requestedLocale, languages = []) {
  const normalized = normalizeLocale(requestedLocale)
  const available = new Set(languages.map((language) => normalizeLocale(language.code)))
  return available.has(normalized) ? normalized : DEFAULT_LANGUAGE
}

export function getNestedValue(dictionary, key) {
  return String(key || '').split('.').reduce((value, part) => (
    value && typeof value === 'object' ? value[part] : undefined
  ), dictionary)
}

export function interpolate(message, variables = {}) {
  return String(message).replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match
  ))
}

export function translate(dictionaries, language, key, variables, fallback) {
  const localized = getNestedValue(dictionaries?.[language], key)
  const english = getNestedValue(dictionaries?.[DEFAULT_LANGUAGE], key)
  const message = localized ?? english ?? fallback ?? key
  return interpolate(message, variables)
}
