import {Decoration, DecoratedRange, DecorationSet, styleModule, WidgetType, ViewField, ViewUpdate, EditorView} from "../../view/src"
import {ChangedRange} from "../../state/src"
import {combineConfig, Extension} from "../../extension/src/extension"
import {countColumn} from "../../doc/src"
import {StyleModule} from "style-mod"

export interface SpecialCharConfig {
  render?: ((code: number, description: string | null, placeHolder: string) => HTMLElement) | null
  specialChars?: RegExp
  addSpecialChars?: RegExp | null
}

export const specialChars = EditorView.extend.unique((configs: SpecialCharConfig[]) => {
  // FIXME make configurations compose properly
  let config = combineConfig(configs, {
    render: null,
    specialChars: SPECIALS,
    addSpecialChars: null
  })

  let styles = document.body.style as any
  let replaceTabs = (styles.tabSize || styles.MozTabSize) == null
  if (replaceTabs) config.specialChars = new RegExp("\t|" + config.specialChars.source, "gu")

  const result = new ViewField<SpecialCharHighlighter>({
    create(view) { return new SpecialCharHighlighter(view, config, replaceTabs) },
    update(self, update) { return self.update(update) },
    effects: [ViewField.decorationEffect(self => self.decorations)]
  }).extension
  return replaceTabs ? Extension.all(result, styleModule(style)) : result
}, {})

const JOIN_GAP = 10

class SpecialCharHighlighter {
  decorations: DecorationSet = Decoration.none
  from = 0
  to = 0
  specials: RegExp

  constructor(public view: EditorView, readonly options: Required<SpecialCharConfig>, private replaceTabs: boolean) {
    this.specials = options.specialChars
    if (options.addSpecialChars) this.specials = new RegExp(this.specials.source + "|" + options.addSpecialChars.source, "gu")
    this.updateForViewport()
  }

  update(update: ViewUpdate) {
    if (update.changes.length) {
      this.decorations = this.decorations.map(update.changes)
      this.from = update.changes.mapPos(this.from, 1)
      this.to = update.changes.mapPos(this.to, -1)
      this.closeHoles(update.changes.changedRanges())
    }
    this.updateForViewport()
    return this
  }

  closeHoles(ranges: ReadonlyArray<ChangedRange>) {
    let decorations: DecoratedRange[] = [], vp = this.view.viewport, replaced: number[] = []
    for (let i = 0; i < ranges.length; i++) {
      let {fromB: from, toB: to} = ranges[i]
      // Must redraw all tabs further on the line
      if (this.replaceTabs) to = this.view.state.doc.lineAt(to).end
      while (i < ranges.length - 1 && ranges[i + 1].fromB < to + JOIN_GAP) to = Math.max(to, ranges[++i].toB)
      // Clip to current viewport, to avoid doing work for invisible text
      from = Math.max(vp.from, from); to = Math.min(vp.to, to)
      if (from >= to) continue
      this.getDecorationsFor(from, to, decorations)
      replaced.push(from, to)
    }
    if (decorations.length)
      this.decorations = this.decorations.update(decorations, pos => {
        for (let i = 0; i < replaced.length; i += 2)
          if (pos >= replaced[i] && pos < replaced[i + 1]) return false
        return true
      }, replaced[0], replaced[replaced.length - 1])
  }

  updateForViewport() {
    let vp = this.view.viewport
    // Viewports match, don't do anything
    if (this.from == vp.from && this.to == vp.to) return
    let decorations: DecoratedRange[] = []
    if (this.from >= vp.to || this.to <= vp.from) {
      this.getDecorationsFor(vp.from, vp.to, decorations)
      this.decorations = Decoration.set(decorations)
    } else {
      if (vp.from < this.from) this.getDecorationsFor(vp.from, this.from, decorations)
      if (this.to < vp.to) this.getDecorationsFor(this.to, vp.to, decorations)
      this.decorations = this.decorations.update(decorations, (from, to) => from >= vp.from && to <= vp.to)
    }
    this.from = vp.from; this.to = vp.to
  }

  getDecorationsFor(from: number, to: number, target: DecoratedRange[]) {
    let {doc} = this.view.state
    for (let pos = from, cursor = doc.iterRange(from, to), m; !cursor.next().done;) {
      if (!cursor.lineBreak) {
        while (m = this.specials.exec(cursor.value)) {
          let code = m[0].codePointAt ? m[0].codePointAt(0) : m[0].charCodeAt(0), widget
          if (code == null) continue
          if (code == 9) {
            let line = doc.lineAt(pos + m.index)
            let size = this.view.state.tabSize, col = countColumn(doc.slice(line.start, pos + m.index), 0, size)
            widget = new TabWidget((size - (col % size)) * this.view.defaultCharacterWidth)
          } else {
            widget = new SpecialCharWidget(this.options, code)
          }
          target.push(Decoration.replace(pos + m.index, pos + m.index + m[0].length, {widget}))
        }
      }
      pos += cursor.value.length
    }
  }

  get styles() { return style }
}

const SPECIALS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff\ufff9-\ufffc]/gu

const NAMES: {[key: number]: string} = {
  0: "null",
  7: "bell",
  8: "backspace",
  10: "newline",
  11: "vertical tab",
  13: "carriage return",
  27: "escape",
  8203: "zero width space",
  8204: "zero width non-joiner",
  8205: "zero width joiner",
  8206: "left-to-right mark",
  8207: "right-to-left mark",
  8232: "line separator",
  8233: "paragraph separator",
  65279: "zero width no-break space",
  65532: "object replacement"
}

// Assigns placeholder characters from the Control Pictures block to
// ASCII control characters
function placeHolder(code: number): string | null {
  if (code >= 32) return null
  if (code == 10) return "\u2424"
  return String.fromCharCode(9216 + code)
}

const DEFAULT_PLACEHOLDER = "\u2022"

class SpecialCharWidget extends WidgetType<number> {
  constructor(private options: Required<SpecialCharConfig>, code: number) { super(code) }

  toDOM() {
    let ph = placeHolder(this.value) || DEFAULT_PLACEHOLDER
    let desc = "Control character " + (NAMES[this.value] || this.value)
    let custom = this.options.render && this.options.render(this.value, desc, ph)
    if (custom) return custom
    let span = document.createElement("span")
    span.textContent = ph
    span.title = desc
    span.setAttribute("aria-label", desc)
    span.style.color = "red"
    return span
  }

  ignoreEvent(): boolean { return false }
}

class TabWidget extends WidgetType<number> {
  toDOM() {
    let span = document.createElement("span")
    span.textContent = "\t"
    span.className = style.tab
    span.style.width = this.value + "px"
    return span
  }

  ignoreEvent(): boolean { return false }
}

const style = new StyleModule({
  tab: {
    display: "inline-block",
    overflow: "hidden",
    verticalAlign: "bottom"
  }
})
