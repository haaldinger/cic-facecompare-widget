/*
 * Copyright 2005-2026 Hyland Software, Inc. and its affiliates. All rights reserved.
 * License rights for this program may be obtained from Hyland Software, Inc. and its affiliates.
 * pursuant to a written agreement and any use of this program without such an
 * agreement is prohibited.
 */

import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { RouterModule } from '@angular/router';
import { ExtensionService } from '@alfresco/adf-extensions';
import { FaceMelterComponent } from './face-melter/face-melter.component';
import { FaceMelterSidenavComponent } from './face-melter/face-melter-sidenav.component';

@NgModule({
    declarations: [FaceMelterComponent, FaceMelterSidenavComponent],
    imports: [CommonModule, MatIconModule, RouterModule],
    exports: [FaceMelterComponent, FaceMelterSidenavComponent]
})
export class PluginsModule {
    constructor(private extensions: ExtensionService) {
        this.extensions.setComponents({
            'face.melter': FaceMelterComponent,
            'face.melter.sidenav': FaceMelterSidenavComponent
        });
    }
}
