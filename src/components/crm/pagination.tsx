import Link from "next/link";

import { MAX_PAGE_SIZE } from "@/lib/crm/leads";
import { Icon } from "@/components/ui/domain";
import { buttonClass } from "@/components/ui/primitives";

/**
 * Previous/Next pagination that preserves the current filters.
 *
 * `linkTo` is supplied by the page so every querystring parameter it cares
 * about survives the jump.
 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  linkTo,
  noun = "record",
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  linkTo: (overrides: Record<string, string | number | undefined>) => string;
  noun?: string;
}) {
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 px-1"
    >
      <p className="text-xs text-muted-foreground">
        Showing <span className="tabular font-medium text-foreground">{first}</span>
        –<span className="tabular font-medium text-foreground">{last}</span> of{" "}
        <span className="tabular font-medium text-foreground">{total}</span>{" "}
        {noun}
        {total === 1 ? "" : "s"}
        {pageSize === MAX_PAGE_SIZE ? " · max page size" : ""}
      </p>

      <div className="flex items-center gap-2">
        <span className="tabular text-xs text-muted-foreground">
          Page {page} of {totalPages}
        </span>

        {page > 1 ? (
          <Link href={linkTo({ page: page - 1 })} className={buttonClass("secondary", "sm")}>
            <Icon name="chevronLeft" size={13} />
            Previous
          </Link>
        ) : (
          <span
            aria-disabled
            className={buttonClass("secondary", "sm", "pointer-events-none opacity-40")}
          >
            <Icon name="chevronLeft" size={13} />
            Previous
          </span>
        )}

        {page < totalPages ? (
          <Link href={linkTo({ page: page + 1 })} className={buttonClass("secondary", "sm")}>
            Next
            <Icon name="chevronRight" size={13} />
          </Link>
        ) : (
          <span
            aria-disabled
            className={buttonClass("secondary", "sm", "pointer-events-none opacity-40")}
          >
            Next
            <Icon name="chevronRight" size={13} />
          </span>
        )}
      </div>
    </nav>
  );
}
