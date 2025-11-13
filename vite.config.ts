
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Added a comment to trigger a reload
export default defineConfig({
  plugins: [react()],
})
