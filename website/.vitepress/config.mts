import { defineConfig } from 'vitepress'

// Deployed at the root of https://openfusion.zyntopia.com (GitHub Pages custom domain).
const BASE = '/'
const SITE_URL = 'https://openfusion.zyntopia.com'

export default defineConfig({
  lang: 'en-US',
  title: 'OpenFusion',
  description:
    'Many models. One considered answer. A local MCP server that fans your prompt out to a panel of AI models, then has a judge write the single answer that should ship.',
  base: BASE,
  sitemap: {
    hostname: SITE_URL
  },
  srcDir: '.',
  appearance: false,
  ignoreDeadLinks: false,
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    ['meta', { name: 'theme-color', content: '#F2F4EE' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=Instrument+Serif:ital@0;1&display=swap'
      }
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: SITE_URL + '/' }],
    ['meta', { property: 'og:title', content: 'OpenFusion — Many models. One considered answer.' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A local MCP server that fans your prompt out to 2–5 AI models, then has a judge read every answer and write one consolidated response. Bring your own keys. No lock-in.'
      }
    ],
    ['meta', { property: 'og:image', content: SITE_URL + '/og.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    [
      'script',
      {
        src: 'https://analytics.zyntopia.com/sdk.js',
        defer: '',
        onload:
          "window.smolanalytics ? window.smolanalytics.init('7948c26a8e21b761a67923155301b7e1', { host: 'https://analytics.zyntopia.com' }) : null"
      }
    ],
    [
      'script',
      {},
      "window.addEventListener('DOMContentLoaded', function() { if (window.smolanalytics) { window.smolanalytics.init('7948c26a8e21b761a67923155301b7e1', { host: 'https://analytics.zyntopia.com' }); } });"
    ]
  ],
  markdown: {
    theme: 'github-dark'
  },
  themeConfig: {
    logo: '/logo-512.png',
    siteTitle: 'OpenFusion',
    outline: { level: [2, 3], label: 'On this page' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' },
          modal: { noResultsText: 'No results', resetButtonTitle: 'Clear' }
        }
      }
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/hashangit/openfusion' }],
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Docs', link: '/docs/' },
      { text: 'Get started', link: '/docs/getting-started.html', pill: true }
    ],
    sidebar: {
      '/docs/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is OpenFusion?', link: '/docs/' },
            { text: 'How it works', link: '/docs/how-it-works.html' }
          ]
        },
        {
          text: 'Get started',
          items: [
            { text: 'Installation', link: '/docs/getting-started.html' },
            { text: 'Connect your agent', link: '/docs/clients.html' }
          ]
        },
        {
          text: 'Configure',
          items: [{ text: 'Configuration', link: '/docs/configuration.html' }]
        },
        {
          text: 'Use',
          items: [
            { text: 'Using the fusion tool', link: '/docs/using-fusion.html' },
            { text: 'The dashboard', link: '/docs/dashboard.html' }
          ]
        },
        {
          text: 'Showcase',
          items: [{ text: 'OpenFusion + Seepient', link: '/docs/seepient.html' }]
        },
        {
          text: 'Help',
          items: [{ text: 'Troubleshooting & FAQ', link: '/docs/troubleshooting.html' }]
        }
      ]
    }
  }
})
