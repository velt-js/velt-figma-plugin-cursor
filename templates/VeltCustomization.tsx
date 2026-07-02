// components/velt/ui-customization/VeltCustomization.tsx
// The SINGLE <VeltWireframe> registry for the whole app (R1). Render it once near the root.
// All customization files live in this folder (R11); exactly ONE stylesheet (R8): ./styles.css.
// Build surfaces ONE AT A TIME (R16) — register a wireframe, verify it, then add the next.
import { VeltWireframe } from "@veltdev/react";
import "./styles.css";

export function VeltCustomization() {
  return (
    <VeltWireframe>
      {/*
        Per-surface wireframes register here. Example:

        <VeltCommentDialogWireframe>
          <VeltCommentDialogWireframe.Body>
            <VeltCommentDialogWireframe.Threads>
              <VeltCommentDialogWireframe.ThreadCard> ... </VeltCommentDialogWireframe.ThreadCard>
            </VeltCommentDialogWireframe.Threads>
          </VeltCommentDialogWireframe.Body>
        </VeltCommentDialogWireframe>

        (ThreadCard MUST nest in Body -> Threads — see guide/reference/wireframe-components.md.)
      */}
    </VeltWireframe>
  );
}
