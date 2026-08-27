declare module "foliate-js/view.js" {
  export class View extends HTMLElement {}
  export function makeBook(file: File | Blob | string, options?: Record<string, unknown>): Promise<unknown>;
}
