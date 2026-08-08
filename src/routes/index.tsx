import { createFileRoute } from "@tanstack/react-router";
import { WireframeApp } from "@/components/wireframe/WireframeApp";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return <WireframeApp />;
}
