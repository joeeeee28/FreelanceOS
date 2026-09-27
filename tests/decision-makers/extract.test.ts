import { describe, expect, it } from "vitest";

import { extractPeopleFromHtml } from "@/lib/decision-makers/extract";

const PAGE = "https://harbour.example.test/about";

describe("decision-maker extraction", () => {
  it("does not create a person from an email string", () => {
    const people = extractPeopleFromHtml(
      "<p>Contact John at john.smith@company.com</p>",
      PAGE,
    );
    expect(people).toEqual([]);
  });

  it("does not verify a title that is only prose", () => {
    const people = extractPeopleFromHtml(
      "<p>John Smith — Head of Marketing — Harbour Physio</p>",
      PAGE,
    );
    expect(people).toEqual([]);
    expect(people.some((person) => person.verification === "PUBLISHED")).toBe(false);
  });

  it("does not turn an author byline into an employee", () => {
    const people = extractPeopleFromHtml(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "BlogPosting",
        author: { "@type": "Person", name: "John Smith", jobTitle: "Head of Marketing" },
      })}</script>`,
      PAGE,
    );
    expect(people).toEqual([]);
  });

  it("keeps a person the company published as an employee", () => {
    const people = extractPeopleFromHtml(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Organization",
        name: "Harbour Physio",
        employee: {
          "@type": "Person",
          name: "Ada Lovelace",
          jobTitle: "Head of Marketing",
        },
      })}</script>`,
      PAGE,
    );

    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      fullName: "Ada Lovelace",
      jobTitle: "Head of Marketing",
      email: null,
      phone: null,
      linkedinUrl: null,
      verification: "PUBLISHED",
      method: "STRUCTURED_DATA",
      sourceUrl: PAGE,
    });
  });

  it("does not invent an email, phone, or LinkedIn profile", () => {
    const people = extractPeopleFromHtml(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Organization",
        name: "Harbour Physio",
        email: "clinic@harbour.example.test",
        employee: { "@type": "Person", name: "Ada Lovelace", jobTitle: "Founder" },
      })}</script>
      <a href="mailto:clinic@harbour.example.test">Email</a>
      <a href="https://linkedin.com/company/harbour">LinkedIn</a>`,
      PAGE,
    );

    expect(people[0]?.email).toBeNull();
    expect(people[0]?.phone).toBeNull();
    expect(people[0]?.linkedinUrl).toBeNull();
  });

  it("keeps a contact method only when it is on that person's card", () => {
    const html = `
      <a href="mailto:clinic@harbour.example.test">Clinic</a>
      <article class="team-member">
        <h3>Ada Lovelace</h3>
        <p>Head of Marketing</p>
        <a href="mailto:ada@harbour.example.test">Ada</a>
        <a href="tel:+914412345678">Phone</a>
        <a href="https://www.linkedin.com/in/ada-lovelace">Profile</a>
      </article>
      <article class="team-member">
        <h3>Grace Hopper</h3>
        <p>Operations Manager</p>
      </article>
    `;
    const people = extractPeopleFromHtml(html, PAGE);
    const ada = people.find((person) => person.canonicalName === "ada lovelace");
    const grace = people.find((person) => person.canonicalName === "grace hopper");

    expect(ada).toMatchObject({
      email: "ada@harbour.example.test",
      phone: "+914412345678",
      linkedinUrl: "https://linkedin.com/in/ada-lovelace",
      verification: "CONTACTABLE",
    });
    expect(grace?.email).toBeNull();
    expect(grace?.verification).toBe("NAME_AND_ROLE");
  });

  it("rejects a malformed address, a company LinkedIn URL, and a one-word name", () => {
    const html = `
      <article class="team-member">
        <h3>Ada Lovelace</h3>
        <p>Head of Marketing</p>
        <a href="mailto:not-an-email">Bad</a>
        <a href="tel:123">Short</a>
        <a href="https://linkedin.com/company/harbour">Company</a>
      </article>
      <article class="team-member">
        <h3>John</h3>
        <p>Owner</p>
      </article>
    `;
    const people = extractPeopleFromHtml(html, PAGE);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      fullName: "Ada Lovelace",
      email: null,
      phone: null,
      linkedinUrl: null,
    });
  });

  it("ignores a person nested as an employee of a different organisation", () => {
    const people = extractPeopleFromHtml(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Organization",
        name: "Harbour Physio",
        employee: {
          "@type": "Person",
          name: "Ada Lovelace",
          jobTitle: "Founder",
          worksFor: { "@type": "Organization", name: "Other Clinic" },
        },
      })}</script>`,
      PAGE,
    );
    expect(people).toEqual([]);
  });

  it("does not parse a huge or empty document", () => {
    expect(extractPeopleFromHtml("", PAGE)).toEqual([]);
    expect(extractPeopleFromHtml("x".repeat(2 * 1024 * 1024 + 1), PAGE)).toEqual([]);
  });
});
