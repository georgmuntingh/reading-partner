import { defineConfig } from 'vite'

export default defineConfig({
  // Set the base path to match your GitHub repository name
  // base: '/reading-partner/',

  // If VITE_BASE_PATH is set (PR), use it. 
  // Otherwise, use the standard production path.
  base: process.env.VITE_BASE_PATH || '/reading-partner/',  
})

