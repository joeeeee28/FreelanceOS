export { acceptedPersonName, extractPeopleFromHtml } from "./extract";
export type { PersonCandidate, PersonVerification } from "./extract";

export {
  contactLine,
  personDisplayState,
  readRole,
} from "./relevance";
export type { PersonDisplayState, RoleReading } from "./relevance";

export { listDecisionMakers, personHistory, storeDiscoveredPeople } from "./store";
export type { StoredPerson, StorePeopleResult } from "./store";

export { reviewCompanyPeople } from "./review";
export type { PeopleReview } from "./review";

export { addDiscoveredPersonToCrm } from "./promote";
export type { PromoteResult } from "./promote";

export {
  interpretDecisionMakers,
  DECISION_MAKER_INTERPRETATION_UNAVAILABLE,
} from "./interpret";
export type { DecisionMakerInterpretation } from "./interpret";
