import assert from 'node:assert/strict'
import {after, before, test} from 'node:test'
import JSZip from 'jszip'

import {readXlsx} from '../web/src/screens/viewer/office.ts'

const unescapeXml = (s) =>
	s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e) => {
		if (e === 'lt') return '<'
		if (e === 'gt') return '>'
		if (e === 'amp') return '&'
		if (e === 'quot') return '"'
		if (e === 'apos') return "'"
		if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
		return String.fromCodePoint(parseInt(e.slice(1), 10))
	})

class XmlElement {
	constructor(tag, attrs, nsMap, parent) {
		this.tagName = tag
		const colon = tag.indexOf(':')
		this.localName = colon >= 0 ? tag.slice(colon + 1) : tag
		this.attrs = attrs
		this.nsMap = nsMap
		this.parent = parent
		this.children = []
		this.parts = []
	}
	getAttribute(name) {
		return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null
	}
	getAttributeNS(nsUri, local) {
		for (const [k, v] of Object.entries(this.attrs)) {
			const c = k.indexOf(':')
			if (c < 0) continue
			if (k.slice(c + 1) !== local) continue
			const prefix = k.slice(0, c)
			if (this.nsMap[prefix] === nsUri) return v
		}
		return null
	}
	getElementsByTagNameNS(_ns, local) {
		const out = []
		const walk = (el) => {
			for (const ch of el.children) {
				if (local === '*' || ch.localName === local) out.push(ch)
				walk(ch)
			}
		}
		walk(this)
		return out
	}
	get textContent() {
		return this.parts.map((p) => (typeof p === 'string' ? p : p.textContent)).join('')
	}
}

class XmlDocument {
	constructor(root) {
		this.root = root
		this.children = root ? [root] : []
	}
	getElementsByTagNameNS(_ns, local) {
		if (!this.root) return []
		const out = local === '*' || this.root.localName === local ? [this.root] : []
		return out.concat(this.root.getElementsByTagNameNS(_ns, local))
	}
}

class SimpleDOMParser {
	parseFromString(src) {
		const rootHolder = new XmlElement('__root__', {}, {}, null)
		const stack = [rootHolder]
		let i = 0
		const len = src.length
		while (i < len) {
			const lt = src.indexOf('<', i)
			if (lt < 0) {
				const txt = src.slice(i)
				if (txt) stack.at(-1).parts.push(unescapeXml(txt))
				break
			}
			if (lt > i) stack.at(-1).parts.push(unescapeXml(src.slice(i, lt)))
			if (src.startsWith('<!--', lt)) {
				const end = src.indexOf('-->', lt + 4)
				i = end < 0 ? len : end + 3
				continue
			}
			if (src.startsWith('<![CDATA[', lt)) {
				const end = src.indexOf(']]>', lt + 9)
				if (end < 0) break
				stack.at(-1).parts.push(src.slice(lt + 9, end))
				i = end + 3
				continue
			}
			if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
				const end = src.indexOf('>', lt + 2)
				i = end < 0 ? len : end + 1
				continue
			}
			if (src[lt + 1] === '/') {
				const end = src.indexOf('>', lt + 2)
				if (stack.length > 1) stack.pop()
				i = end < 0 ? len : end + 1
				continue
			}
			let gt = lt + 1
			let quote = ''
			while (gt < len) {
				const ch = src[gt]
				if (quote) {
					if (ch === quote) quote = ''
				} else if (ch === '"' || ch === "'") {
					quote = ch
				} else if (ch === '>') {
					break
				}
				gt++
			}
			const rawTag = src.slice(lt + 1, gt)
			const selfClosing = rawTag.endsWith('/')
			const body = (selfClosing ? rawTag.slice(0, -1) : rawTag).trim()
			const sp = body.search(/[\s]/)
			const tagName = sp < 0 ? body : body.slice(0, sp)
			const attrStr = sp < 0 ? '' : body.slice(sp + 1)
			const attrs = {}
			const nsMap = {...stack.at(-1).nsMap}
			for (const m of attrStr.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
				const val = unescapeXml(m[2] ?? m[3] ?? '')
				attrs[m[1]] = val
				if (m[1].startsWith('xmlns:')) nsMap[m[1].slice(6)] = val
			}
			const el = new XmlElement(tagName, attrs, nsMap, stack.at(-1))
			stack.at(-1).children.push(el)
			stack.at(-1).parts.push(el)
			if (!selfClosing) stack.push(el)
			i = gt + 1
		}
		return new XmlDocument(rootHolder.children[0] ?? null)
	}
}

let prevDOMParser
before(() => {
	prevDOMParser = globalThis.DOMParser
	globalThis.DOMParser = SimpleDOMParser
})
after(() => {
	globalThis.DOMParser = prevDOMParser
})

async function makeXlsx({workbookXml, stylesXml, sharedStringsXml, sheetXml}) {
	const zip = new JSZip()
	zip.file(
		'xl/workbook.xml',
		workbookXml ??
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
				'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
	)
	zip.file(
		'xl/_rels/workbook.xml.rels',
		'<?xml version="1.0" encoding="UTF-8"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
			'</Relationships>',
	)
	if (stylesXml) zip.file('xl/styles.xml', stylesXml)
	if (sharedStringsXml) zip.file('xl/sharedStrings.xml', sharedStringsXml)
	zip.file('xl/worksheets/sheet1.xml', sheetXml)
	const buf = await zip.generateAsync({type: 'arraybuffer'})
	return buf
}

test('readXlsx renders [h]:mm, [h]:mm:ss, [m]:ss, and [s] durations instead of 1899 dates', async () => {
	const buf = await makeXlsx({
		stylesXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
			'<numFmts count="5">' +
			'<numFmt numFmtId="164" formatCode="[h]:mm"/>' +
			'<numFmt numFmtId="165" formatCode="[h]:mm:ss"/>' +
			'<numFmt numFmtId="166" formatCode="[m]:ss"/>' +
			'<numFmt numFmtId="167" formatCode="[s]"/>' +
			'<numFmt numFmtId="168" formatCode="0&quot;[h]&quot;"/>' +
			'</numFmts>' +
			'<cellXfs count="6">' +
			'<xf numFmtId="164"/>' +
			'<xf numFmtId="46"/>' +
			'<xf numFmtId="165"/>' +
			'<xf numFmtId="166"/>' +
			'<xf numFmtId="167"/>' +
			'<xf numFmtId="168"/>' +
			'</cellXfs>' +
			'</styleSheet>',
		sheetXml:
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
			'<row r="1"><c r="A1" s="0"><v>0.5</v></c><c r="B1" s="0"><v>1.25</v></c><c r="C1" s="0"><v>1.5</v></c></row>' +
			'<row r="2"><c r="A2" s="1"><v>1.5</v></c><c r="B2" s="2"><v>1.5</v></c><c r="C2" s="0"><v>-0.5</v></c></row>' +
			'<row r="3"><c r="A3" s="3"><v>0.0625</v></c><c r="B3" s="4"><v>0.001</v></c><c r="C3" s="5"><v>42</v></c></row>' +
			'</sheetData></worksheet>',
	})
	const sheets = await readXlsx(buf)
	assert.deepEqual(sheets[0].rows, [
		['12:00', '30:00', '36:00'],
		['36:00:00', '36:00:00', '-12:00'],
		['90:00', '86', '42'],
	])
})
