/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./client/index.html', './client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 日间：冷灰底 + 米白卡片（继承 EAgentX 浅色主题）
        day: {
          bg: '#eef1f5',
          panel: '#fbfaf7',
          card: '#ffffff',
          line: '#dfe3ea',
          text: '#252b34',
          muted: '#6b7482',
          accent: '#3c6df0',
        },
        // 夜间：深灰蓝底 + 深灰卡片
        night: {
          bg: '#121721',
          panel: '#171d29',
          card: '#1d2432',
          line: '#2a3342',
          text: '#e6eaf2',
          muted: '#93a0b4',
          accent: '#6f9bff',
        },
      },
      borderRadius: { xl2: '16px' },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'Consolas', '"Courier New"', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(16,24,40,.06), 0 8px 24px -12px rgba(16,24,40,.18)',
      },
    },
  },
  plugins: [],
};
