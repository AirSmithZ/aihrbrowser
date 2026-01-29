import baseConfig from '@extension/tailwindcss-config';
import type { Config } from 'tailwindcss/types/config';

export default {
  ...baseConfig,
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      keyframes: {
        progress: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        thinkDot: {
          '0%, 60%, 100%': { transform: 'scale(0.85)', opacity: '0.6' },
          '30%': { transform: 'scale(1.1)', opacity: '1' },
        },
        thinkBar: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(200%)' },
        },
      },
      animation: {
        progress: 'progress 1.5s infinite ease-in-out',
        thinkDot: 'thinkDot 1.2s ease-in-out infinite',
        thinkBar: 'thinkBar 1.8s ease-in-out infinite',
      },
    },
  },
} as Config;
