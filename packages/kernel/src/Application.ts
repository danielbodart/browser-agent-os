import {LazyMap} from "@bodar/yadic/LazyMap.ts";
import {LocalKernel, type LocalKernelDependencies} from "./LocalKernel.ts";

export type ApplicationDependencies = LocalKernelDependencies;

export function application(deps: ApplicationDependencies) {
    return LazyMap.create(deps)
        .set('kernel', deps => new LocalKernel(deps));
}
