export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#0A1931',
        deepnavy: '#06101F',
        glowyellow: '#FFD60A',
        softyellow: '#FFE45E'
      },
      boxShadow: {
        glow: '0 0 30px rgba(255, 214, 10, 0.25)',
        strong: '0 0 80px rgba(255, 214, 10, 0.16)'
      }
    }
  },
  plugins: []
};
