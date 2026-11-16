// Lets `node --test` load src/*.ts the way the app's bundlers do: source
// files import each other without an extension ("./analytics"), which
// Node's own resolver won't accept.
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
