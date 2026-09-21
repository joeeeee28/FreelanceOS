import { Icon, type IconName } from "@/components/ui/domain";
import { Card, CardBody, LinkButton } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/page";

/**
 * Honest placeholder for a module that has no backend yet.
 *
 * It states plainly that the feature is not built, explains what it will do,
 * and points at the parts of the product that do work. It never renders
 * sample records, mock charts or placeholder numbers.
 */
export function ModulePlaceholder({
  title,
  icon,
  summary,
  planned,
  availableNow,
}: {
  title: string;
  icon: IconName;
  summary: string;
  planned: string[];
  availableNow: { label: string; href: string };
}) {
  return (
    <>
      <PageHeader
        title={title}
        description="This module is not built yet."
        actions={
          <LinkButton href={availableNow.href} variant="secondary">
            {availableNow.label}
          </LinkButton>
        }
      />

      <Card>
        <CardBody className="max-w-2xl">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              <Icon name={icon} />
            </span>

            <div>
              <p className="text-sm font-semibold">Coming in a later phase</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {summary}
              </p>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <p className="text-2xs font-semibold uppercase tracking-wide text-subtle-foreground">
              Planned capabilities
            </p>
            <ul className="mt-2.5 space-y-1.5">
              {planned.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Icon
                    name="chevronRight"
                    size={12}
                    className="mt-1 shrink-0 text-subtle-foreground"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-5 rounded-md border border-border bg-surface-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            Nothing on this page is simulated. No sample records, metrics or
            charts are shown, because none of this data exists yet.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
