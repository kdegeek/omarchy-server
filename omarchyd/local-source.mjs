// Resolve OMARCHY_SERVER_SOURCE / OMARCHY_SERVER_APP_STORE to a local git directory.
// Unset or whitespace → GitHub. Any other value that is not an absolute git dir is an error:
// a set isolation directive must not silently fall back to fetching GitHub.
import {statSync} from 'node:fs'
import {isAbsolute, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const hint = (name) => (name === 'OMARCHY_SERVER_APP_STORE' ? 'use the GitHub app store' : 'update from GitHub')

export function localGitDir(name, raw) {
	if (raw == null) return undefined
	const path = String(raw).trim()
	if (!path) return undefined
	if (!isAbsolute(path)) {
		throw new Error(`${name} is set to "${path}" but must be an absolute path. Unset it to ${hint(name)}, or point it at a local clone.`)
	}
	let dir
	try {
		dir = statSync(path)
	} catch {
		dir = null
	}
	let git
	try {
		git = statSync(join(path, '.git'))
	} catch {
		git = null
	}
	if (!dir?.isDirectory() || !git) {
		throw new Error(`${name} is set to "${path}" but that path is not a git repository. Unset it to ${hint(name)}, or point it at a local clone.`)
	}
	return resolve(path)
}

export const fileUrl = (path) => pathToFileURL(resolve(path)).href
