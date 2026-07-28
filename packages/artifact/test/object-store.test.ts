import { InMemoryObjectStore } from "../src/index.js";
import { objectStoreConformance } from "./object-store-conformance.js";

objectStoreConformance("InMemoryObjectStore", {
  createStore() {
    return new InMemoryObjectStore();
  },
});
