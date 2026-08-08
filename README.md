# Digital Ocean

Interactive **3D GPU wireframe ocean** — a retro digital reef scene built with React, Three.js, and React Three Fiber.

## Features

- Undulating wireframe ocean **surface** (ceiling view from underwater)
- Static **sea floor** meeting cliff bases, with coral colonies planted on the sand
- Wireframe **sea cliffs**, coral, and a soft sun/sky
- School of **cellular automata tropical fish**
  - High-polygon wireframe bodies with **soft-body physics** (Verlet + springs)
  - CA-driven schooling (boids + ring cellular automaton) for emergent swim waves
  - Completely **indifferent** to mouse / tap / pointer — only the camera orbits on drag
- **Great white sharks** with high-polygon anatomy and soft-body physics
  - Realistic proportions from multi-angle reference (side, top, bottom, front)
  - Countershaded wireframe (steel dorsal / white ventral), full fin set, gills, teeth
  - Thunniform soft-body swim (stiff head, flexible caudal)
  - Cruise **much slower** than tropical fish; **hunt only when hungry**
  - Pursue fish, dolphins, **and mermaids** when hungry (prey usually out-swim them)
- **Bottlenose dolphins** with high-polygon anatomy and soft-body physics
  - Anatomy from multi-angle refs: side profile, dorsal/top, ventral, frontal
  - Rostrum + melon, blowhole, falcate dorsal, pectoral flippers, **horizontal flukes**
  - Countershaded slate-grey dorsal / pale ventral
  - Soft-body **dorsoventral** undulation (cetacean fluke drive — not lateral like sharks)
  - **Friendly & curious** about the cursor/pointer (approach, circle, investigate)
  - **Alarm & flee** when sharks come near; swim **faster** than great whites
- **Female mermaids** with high-polygon anatomy and soft-body physics
  - Multi-angle anatomy: side profile, front torso, dorsal/top, ventral
  - Human feminine upper body (head, bust, waist, hips) transitioning to scaled fish tail
  - Flowing hair, arms, seashell accents, caudal fluke + hip fins + dorsal fin
  - Soft-body **lateral** undulation (fish drive) with soft torso/hair motion
  - **Friendly & curious** about the cursor/pointer
  - **Flee hunting sharks more strongly than they are attracted to the cursor**
  - Swim **faster** than great whites (cruise and burst)
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
