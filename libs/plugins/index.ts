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
import { FaceCompareComponent } from './face-compare/face-compare.component';
import { FaceCompareSidenavComponent } from './face-compare/face-compare-sidenav.component';
import { FormsModule } from '@angular/forms';

@NgModule({
    declarations: [FaceCompareComponent, FaceCompareSidenavComponent],
    imports: [CommonModule, MatIconModule, RouterModule, FormsModule],
    exports: [FaceCompareComponent, FaceCompareSidenavComponent]
})
export class PluginsModule {
    constructor(private extensions: ExtensionService) {
        this.extensions.setComponents({
            'face.compare': FaceCompareComponent,
            'face.compare.sidenav': FaceCompareSidenavComponent
        });
    }
}
