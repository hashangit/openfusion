<script setup>
defineProps({ ghost: Boolean })
</script>

<template>
  <svg
    class="confluence"
    :class="{ ghost }"
    viewBox="0 0 600 470"
    fill="none"
    role="img"
    aria-label="Five differently coloured streams merge into one river — OpenFusion fans a prompt out to several models, and a judge writes one answer"
  >
    <defs>
      <linearGradient id="cf-river" x1="300" y1="296" x2="300" y2="440" gradientUnits="userSpaceOnUse">
        <stop stop-color="#3B6B4C" />
        <stop offset="1" stop-color="#2A4E37" />
      </linearGradient>
      <radialGradient id="cf-glow" cx="0.5" cy="0.5" r="0.5">
        <stop stop-color="#A9BC90" stop-opacity="0.45" />
        <stop offset="1" stop-color="#A9BC90" stop-opacity="0" />
      </radialGradient>
    </defs>

    <circle v-if="!ghost" class="cf-glow" cx="300" cy="298" r="96" fill="url(#cf-glow)" />

    <!-- tributaries: stone · wood · forest · water · moss -->
    <path class="flow" pathLength="1" d="M92 -12 C 96 120, 170 208, 300 296" stroke="#8B8570" stroke-width="3" stroke-linecap="round" />
    <path class="flow" pathLength="1" d="M196 -12 C 194 140, 234 238, 300 298" stroke="#8A6748" stroke-width="2.6" stroke-linecap="round" />
    <path class="flow" pathLength="1" d="M300 -12 C 300 130, 300 200, 300 296" stroke="#3B6B4C" stroke-width="3" stroke-linecap="round" />
    <path class="flow" pathLength="1" d="M404 -12 C 406 140, 366 238, 300 298" stroke="#4E7F9E" stroke-width="2.6" stroke-linecap="round" />
    <path class="flow" pathLength="1" d="M508 -12 C 504 120, 430 208, 300 296" stroke="#A9BC90" stroke-width="3" stroke-linecap="round" />

    <!-- the merged river -->
    <path
      class="flow cf-river-path"
      pathLength="1"
      d="M300 298 C 300 336, 300 360, 300 414"
      stroke="url(#cf-river)"
      stroke-width="7"
      stroke-linecap="round"
    />

    <g class="cf-node">
      <circle cx="300" cy="432" r="26" fill="#263B2C" />
      <path
        d="M300 419 C 301.6 426.6, 303.4 428.4, 311 432 C 303.4 435.6, 301.6 437.4, 300 445 C 298.4 437.4, 296.6 435.6, 289 432 C 296.6 428.4, 298.4 426.6, 300 419 Z"
        fill="#A9BC90"
      />
    </g>
  </svg>
</template>
