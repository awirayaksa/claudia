// The desktop theme is the base; content also covers the shared components in ../src.
import base from '../tailwind.config.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [base],
  content: ['./index.html', './client/**/*.{ts,tsx}', '../src/**/*.{ts,tsx}'],
};
