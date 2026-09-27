/**
 * JASSUB 2.4.1's Emscripten binding emits one dynamic Function factory. Replace
 * that fixed argument-conversion recipe with ordinary closures at build time,
 * so ASS works under the application's existing CSP without unsafe-eval.
 * This does not alter libass, the WASM binaries, fonts, or subtitle contents.
 */
export const cspInvokerSource = `function createJsInvoker(argTypes, isClassMethodFunc, returns, isAsync) {
  var needsDestructorStack = usesDestructorStack(argTypes);
  var argCount = argTypes.length - 2;
  return function(humanName, throwBindingError, invoker, fn, runDestructors, fromRetWire, toClassParamWire, ...converters) {
    var invoke = function(...args) {
      var destructors = needsDestructorStack ? [] : null;
      var wired = [fn];
      if (isClassMethodFunc) wired.push(toClassParamWire(destructors, this));
      for (var i = 0; i < argCount; i++) wired.push(converters[i](destructors, args[i]));
      var result = invoker(...wired);
      if (needsDestructorStack) runDestructors(destructors);
      else {
        var destructorIndex = argCount;
        var wiredIndex = 1;
        for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; i++, wiredIndex++) {
          if (argTypes[i].destructorFunction !== null) converters[destructorIndex++](wired[wiredIndex]);
        }
      }
      if (returns) return fromRetWire(result);
    };
    Object.defineProperty(invoke, "length", { value: argCount });
    return invoke;
  };
}`;

export function transformJassubCsp(source: string, id: string) {
  if (!/[\\/]jassub[\\/]dist[\\/]wasm[\\/]jassub-worker\.js(?:\?|$)/.test(id)) return null;
  const start = source.indexOf("function createJsInvoker("), end = source.indexOf("function craftInvokerFunction(", start);
  if (start < 0 || end <= start || !source.slice(start, end).includes("return new Function(args1, invokerFnBody)")) throw new Error("JASSUB binding changed: review CSP-safe invoker before building");
  return source.slice(0, start) + cspInvokerSource + "\n    " + source.slice(end);
}

export function jassubCspPlugin() {
  return { name: "lmd-jassub-csp", enforce: "pre" as const, transform(code: string, id: string) { const transformed = transformJassubCsp(code, id); return transformed ? { code: transformed, map: null } : null; } };
}
