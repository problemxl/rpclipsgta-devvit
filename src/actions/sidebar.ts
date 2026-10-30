/** Framework-free sidebar textarea selection and update seam. */

export interface SidebarWidgetLike {
  readonly id: string;
  readonly name: string;
  readonly text?: unknown;
  readonly css?: unknown;
}

export interface SidebarWidgetUpdate {
  readonly type: 'textarea';
  readonly subreddit: string;
  readonly id: string;
  readonly shortName: string;
  readonly text: string;
}

export interface SidebarWidgetAdd {
  readonly type: 'textarea';
  readonly subreddit: string;
  readonly shortName: string;
  readonly text: string;
}

export interface SidebarWidgetDeps {
  readonly getWidgets: (subredditName: string) => Promise<readonly SidebarWidgetLike[]>;
  readonly addWidget: (widget: SidebarWidgetAdd) => Promise<unknown>;
  readonly updateWidget: (widget: SidebarWidgetUpdate) => Promise<unknown>;
}

export interface SidebarWidgetResult {
  readonly status: 'updated' | 'created';
  readonly shortName: string;
}

/** A same-name non-textarea widget must not be silently replaced. */
export class SidebarWidgetConflictError extends Error {
  constructor(shortName: string) {
    super(`Sidebar widget name "${shortName}" is already used by a non-textarea widget.`);
    this.name = 'SidebarWidgetConflictError';
  }
}

function isTextareaWidget(widget: SidebarWidgetLike): boolean {
  // TextAreaWidget and CustomWidget both expose text. CSS is the discriminator
  // documented by the app's runtime API notes.
  return typeof widget.text === 'string' && widget.css === undefined;
}

/** Update the named textarea, or create it when no widget has that name. */
export async function refreshSidebarWidget(
  deps: SidebarWidgetDeps,
  input: { readonly subredditName: string; readonly widgetShortName: string; readonly text: string }
): Promise<SidebarWidgetResult> {
  const widgets = await deps.getWidgets(input.subredditName);
  const sameName = widgets.filter((widget) => widget.name === input.widgetShortName);
  if (sameName.some((widget) => !isTextareaWidget(widget))) {
    throw new SidebarWidgetConflictError(input.widgetShortName);
  }
  const textarea = sameName.find(isTextareaWidget);

  if (textarea) {
    await deps.updateWidget({
      type: 'textarea',
      subreddit: input.subredditName,
      id: textarea.id,
      shortName: input.widgetShortName,
      text: input.text,
    });
    return { status: 'updated', shortName: input.widgetShortName };
  }

  await deps.addWidget({
    type: 'textarea',
    subreddit: input.subredditName,
    shortName: input.widgetShortName,
    text: input.text,
  });
  return { status: 'created', shortName: input.widgetShortName };
}
