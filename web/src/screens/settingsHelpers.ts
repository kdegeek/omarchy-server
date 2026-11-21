// Pure helpers and constants for Settings sheets.
export const PASSWORD_SHEET_SUBTITLE = 'Used to sign in to Omarchy Server'

export const TOTP_URI_QUERY_KEY = ['user.generateTotpUri'] as const

// One setup key while the sheet stays open (switching to the authenticator app and back must keep it).
export const TOTP_URI_QUERY_OPTIONS = {
	staleTime: Infinity,
	refetchOnWindowFocus: false,
	refetchOnReconnect: false,
} as const

export function clearTotpSetupUri(qc: {removeQueries: (filters: {queryKey: readonly string[]}) => void}) {
	qc.removeQueries({queryKey: TOTP_URI_QUERY_KEY})
}
