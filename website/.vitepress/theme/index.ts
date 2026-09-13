import DefaultTheme from 'vitepress/theme'
import { defineComponent, h, onMounted } from 'vue'
import Confluence from './Confluence.vue'
import './custom.css'

/**
 * SVG filter defs for the liquid-glass edge refraction (Chromium only —
 * `backdrop-filter: url(#…)` is unsupported in Safari/Firefox, which fall
 * back to the plain blur via the `.of-refract` gate below).
 */
const Layout = defineComponent({
  name: 'OfLayout',
  setup() {
    onMounted(() => {
      const supports = window.CSS && (CSS.supports('backdrop-filter', 'url(#of-glass-edge)') || CSS.supports('-webkit-backdrop-filter', 'url(#of-glass-edge)'))
      if (supports) document.documentElement.classList.add('of-refract')
    })
    return () =>
      h('div', { class: 'of-root' }, [
        h('div', { class: 'of-glass-defs', 'aria-hidden': 'true' }, [
          h('svg', { width: '0', height: '0', focusable: 'false' }, [
            h('filter', { id: 'of-glass-edge', x: '-20%', y: '-20%', width: '140%', height: '140%', 'color-interpolation-filters': 'sRGB' }, [
              h('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.012 0.018', numOctaves: '2', seed: '11', result: 'warp' }),
              h('feDisplacementMap', { in: 'SourceGraphic', in2: 'warp', scale: '18', xChannelSelector: 'R', yChannelSelector: 'G' })
            ])
          ])
        ]),
        h(DefaultTheme.Layout)
      ])
  }
})

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('Confluence', Confluence)
  }
}
