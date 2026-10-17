import 'vue';

declare module 'vue' {
  interface HTMLAttributes {
    /** HTML's standard application data attributes, shared with scene adapters. */
    [key: `data-${string}`]: string | number | boolean | null | undefined;
  }
  interface SVGAttributes { hidden?: boolean }
  interface ComponentCustomProps { hidden?: boolean }
}
