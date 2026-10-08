// Listes automatiques dans l'éditeur de texte Excalidraw.
//
// Comportement (type Notion) :
// - une ligne qui commence par `- ` (ou `* `, `• `, `1. `, `1) `) est un item ;
// - Entrée sur un item non vide insère un nouvel item identique en dessous ;
// - Entrée sur un item vide dont le précédent est un item non vide quitte
//   la liste (le tiret disparaît, retour au texte normal) ;
// - Entrée sur un tiret seul (`-`, `- `, `1. `…) démarre une nouvelle liste,
//   même après du texte normal : le tiret doit juste être en début de ligne ;
// - Retour arrière juste après le tiret d'un item vide (ou après le préfixe)
//   supprime le tiret d'un coup.
//
// L'éditeur Excalidraw est un `textarea.excalidraw-wysiwyg` créé en interne :
// on l'intercepte en phase de capture depuis l'hôte, avant son `onkeydown`
// natif (qui ne fait rien pour Entrée simple). Après chaque réécriture on
// rejoue un évènement `input`, comme le fait Excalidraw pour Tab : c'est ce
// qui redimensionne la zone et propage le texte à la scène.

type ListMarker =
  | {
      kind: 'bullet'
      indent: string
      marker: string
      prefix: string
      after: string
      bare: boolean
    }
  | {
      kind: 'ordered'
      indent: string
      number: number
      delimiter: string
      prefix: string
      after: string
      bare: boolean
    }

const BULLET_RE = /^(\s*)([-*•])[ \t]+(.*)$/
const ORDERED_RE = /^(\s*)(\d{1,9})([.)])[ \t]+(.*)$/
const BARE_BULLET_RE = /^(\s*)([-*•])[ \t]*$/
const BARE_ORDERED_RE = /^(\s*)(\d{1,9})([.)])[ \t]*$/

function parseListMarker(line: string): ListMarker | null {
  const bullet = line.match(BULLET_RE)
  if (bullet) {
    const [, indent, marker, after] = bullet as unknown as [string, string, string, string]
    return { kind: 'bullet', indent, marker, prefix: `${indent}${marker} `, after, bare: false }
  }
  const ordered = line.match(ORDERED_RE)
  if (ordered) {
    const [, indent, digits, delimiter, after] = ordered as unknown as [
      string,
      string,
      string,
      string,
      string
    ]
    return {
      kind: 'ordered',
      indent,
      number: Number.parseInt(digits, 10),
      delimiter,
      prefix: `${indent}${digits}${delimiter} `,
      after,
      bare: false
    }
  }
  // Tiret seul, sans espace ni contenu (`-`, `  -`, `1.`…) : item vide
  // à normaliser (`- `) plutôt qu'une ligne ordinaire.
  const bareBullet = line.match(BARE_BULLET_RE)
  if (bareBullet) {
    const [, indent, marker] = bareBullet as unknown as [string, string, string]
    return { kind: 'bullet', indent, marker, prefix: `${indent}${marker} `, after: '', bare: true }
  }
  const bareOrdered = line.match(BARE_ORDERED_RE)
  if (bareOrdered) {
    const [, indent, digits, delimiter] = bareOrdered as unknown as [
      string,
      string,
      string,
      string
    ]
    return {
      kind: 'ordered',
      indent,
      number: Number.parseInt(digits, 10),
      delimiter,
      prefix: `${indent}${digits}${delimiter} `,
      after: '',
      bare: true
    }
  }
  return null
}

function lineBounds(value: string, cursor: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', cursor - 1) + 1
  const next = value.indexOf('\n', cursor)
  return { start, end: next === -1 ? value.length : next }
}

export type TextEdit = { value: string; cursor: number }

/**
 * Calcule l'effet d'Entrée dans un textarea. Retourne `null` pour laisser le
 * comportement natif (pas une ligne de liste, sélection multiple, curseur
 * dans le préfixe…).
 */
export function computeEnterEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number
): TextEdit | null {
  if (selectionStart !== selectionEnd) return null
  const { start, end } = lineBounds(value, selectionStart)
  const marker = parseListMarker(value.slice(start, end))
  if (!marker) return null
  const cursorInLine = selectionStart - start
  // Curseur dans le préfixe (`-` lui-même) : insertion simple, sans liste.
  // Pour un tiret seul (`-`), le préfixe canonique (`- `) n'existe pas encore :
  // le curseur juste après le tiret suffit.
  const minCursor = marker.bare ? marker.prefix.length - 1 : marker.prefix.length
  if (cursorInLine < minCursor) return null
  if (marker.after.trim() !== '') {
    return continueList(value, selectionStart, marker)
  }
  // Item vide : on quitte la liste seulement si la ligne précédente est un
  // item non vide ; sinon (`-` seul, après du texte normal ou en début de
  // zone) on démarre une nouvelle liste.
  if (previousLineIsFullItem(value, start)) {
    // Le tiret disparaît et le curseur reste sur la ligne redevenue normale.
    return { value: value.slice(0, start) + value.slice(end), cursor: start }
  }
  const head = value.slice(0, start)
  const tail = value.slice(end)
  const nextPrefix = nextItemPrefix(marker)
  return {
    value: `${head}${marker.prefix}\n${nextPrefix}${tail}`,
    cursor: start + marker.prefix.length + 1 + nextPrefix.length
  }
}

/** Préfixe de l'item suivant : même tiret (même retrait), numéro + 1. */
function nextItemPrefix(marker: ListMarker): string {
  return marker.kind === 'bullet'
    ? `${marker.indent}${marker.marker} `
    : `${marker.indent}${marker.number + 1}${marker.delimiter} `
}

/** Insère un nouvel item sous le curseur en coupant la ligne courante. */
function continueList(value: string, selectionStart: number, marker: ListMarker): TextEdit {
  const nextPrefix = nextItemPrefix(marker)
  const head = value.slice(0, selectionStart)
  const tail = value.slice(selectionStart)
  return {
    value: `${head}\n${nextPrefix}${tail}`,
    cursor: selectionStart + 1 + nextPrefix.length
  }
}

/** Vrai si la ligne juste avant est un item de liste non vide. */
function previousLineIsFullItem(value: string, lineStart: number): boolean {
  if (lineStart === 0) return false
  const prevEnd = lineStart - 1 // l'index du '\n' qui termine la ligne précédente
  const prevStart = value.lastIndexOf('\n', prevEnd - 1) + 1
  const prev = parseListMarker(value.slice(prevStart, prevEnd))
  return !!prev && prev.after.trim() !== ''
}

/** Efface le tiret d'un coup quand le curseur est juste après. Sinon `null`. */
export function computeBackspaceEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number
): TextEdit | null {
  if (selectionStart !== selectionEnd || selectionStart === 0) return null
  const { start, end } = lineBounds(value, selectionStart)
  const marker = parseListMarker(value.slice(start, end))
  if (!marker) return null
  const cursorInLine = selectionStart - start
  if (cursorInLine === 0) return null
  if (marker.after.trim() === '') {
    // Item vide : tout le tiret (et ses espaces) part d'un coup.
    if (cursorInLine > marker.prefix.length) return null
    return { value: value.slice(0, start) + value.slice(end), cursor: start }
  }
  if (cursorInLine !== marker.prefix.length) return null
  return {
    value: value.slice(0, start) + value.slice(start + marker.prefix.length),
    cursor: start
  }
}

function isListEditor(target: EventTarget | null): target is HTMLTextAreaElement {
  return (
    target instanceof HTMLTextAreaElement && target.classList.contains('excalidraw-wysiwyg')
  )
}

export function attachTextLists(host: HTMLElement): () => void {
  const apply = (editable: HTMLTextAreaElement, edit: TextEdit) => {
    editable.value = edit.value
    editable.selectionStart = edit.cursor
    editable.selectionEnd = edit.cursor
    // Même signal que l'indentation native Tab d'Excalidraw : l'éditeur
    // recalcule sa taille et pousse le texte dans la scène.
    editable.dispatchEvent(new Event('input'))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isListEditor(event.target)) return
    if (event.isComposing || event.keyCode === 229) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const editable = event.target
    if (event.key === 'Enter') {
      const edit = computeEnterEdit(editable.value, editable.selectionStart, editable.selectionEnd)
      if (!edit) return
      event.preventDefault()
      event.stopPropagation()
      apply(editable, edit)
    } else if (event.key === 'Backspace' && !event.shiftKey) {
      const edit = computeBackspaceEdit(
        editable.value,
        editable.selectionStart,
        editable.selectionEnd
      )
      if (!edit) return
      event.preventDefault()
      event.stopPropagation()
      apply(editable, edit)
    }
  }

  host.addEventListener('keydown', onKeyDown, true)
  return () => host.removeEventListener('keydown', onKeyDown, true)
}
