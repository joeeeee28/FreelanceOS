"use client";

import { useActionState } from "react";

import { discoverBusinessesAction } from "@/app/(app)/find-clients/actions";
import { IDLE, type ActionResult } from "@/lib/crm/action-result";

import { Field, FormStatus, SubmitButton } from "./form-controls";

export function DiscoverBusinessesForm({
  places,
  services,
}: {
  places: readonly { key: string; label: string }[];
  services: readonly { key: string; label: string }[];
}) {
  const [state, formAction] = useActionState(discoverBusinessesAction, IDLE as ActionResult);
  const errors = state.status === "error" ? state.fieldErrors : {};

  return (
    <form id="discover" action={formAction} className="mt-4 grid gap-3 sm:grid-cols-2">
      <Field label="Query" name="query" errors={errors.query} hint="A supported place type, such as dental clinic.">
        <input name="query" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
      </Field>
      <Field label="Location" name="location" errors={errors.location} hint="City and country. Example: Chennai, India.">
        <input name="location" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
      </Field>
      <Field label="Business type" name="businessType" errors={errors.businessType}>
        <select name="businessType" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" defaultValue="">
          <option value="">Match the query</option>
          {places.map((place) => (
            <option key={place.key} value={place.key}>
              {place.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Industry" name="industry" errors={errors.industry} hint="Optional. Stored as a request, not as a company fact.">
        <input name="industry" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" />
      </Field>
      <Field label="Maximum" name="maxCompanies" errors={errors.maxCompanies} hint="1 to 25. Default 5.">
        <input
          name="maxCompanies"
          type="number"
          min={1}
          max={25}
          defaultValue={5}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
        />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-xs font-medium">Requested services</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {services.map((service) => (
            <label key={service.key} className="flex items-center gap-2 text-xs">
              <input type="checkbox" name="service" value={service.key} />
              {service.label}
            </label>
          ))}
        </div>
        {errors.service ? <p className="mt-1 text-xs text-danger">{errors.service.join(" ")}</p> : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton size="sm">Discover new businesses</SubmitButton>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
