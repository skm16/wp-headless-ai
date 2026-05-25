import { renderJabIcon } from "@/lib/jab-icon";

export const runtime = "edge";

export function GET() {
  return renderJabIcon(192);
}
