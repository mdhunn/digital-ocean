# Digital Ocean

Interactive **3D GPU wireframe ocean** — a retro digital reef scene built with React, Three.js, and React Three Fiber.

## Features

- Undulating wireframe ocean **surface** (ceiling view from underwater)
- Static **sea floor** meeting cliff bases, with coral colonies planted on the sand
- Wireframe **sea cliffs**, coral, and a soft sun/sky
- Corner **digital clock** with month calendar
  - Starts in **24-hour** mode
  - Tap to cycle: 24-hour → 12-hour → hidden
- Works on phone, tablet, and desktop (portrait & landscape)
- Cheerful, soothing teal / coral palette — no on-screen instructions

## Stack

- React 19 + TypeScript
- Vite 8 + TanStack Start / Router
- Three.js + `@react-three/fiber` + `@react-three/drei`
- Tailwind CSS v4

## Develop

```bash
npm install
npm run dev
```

App serves on `http://localhost:8080`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Dev server on `0.0.0.0:8080` |
| `npm run build` | Production build (Vercel) |
| `npm run typecheck` | TypeScript check |
| `npm run preview` | Preview production build |

## License

Personal project — use freely.
