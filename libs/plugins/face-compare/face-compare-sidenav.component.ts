import { Component } from '@angular/core';

@Component({
    selector: 'app-face-compare-sidenav',
    standalone: false,
    template: `
        <div class="sidenav-section">
            <div class="sidenav-section-header">Visual Inspector</div>
            <a class="sidenav-item" routerLink="/face-compare" routerLinkActive="active">
                <mat-icon>compare</mat-icon>
                <span class="sidenav-item-label">Compare Images</span>
            </a>
        </div>
    `,
    styles: [`
        .sidenav-section {
            padding: 8px 0;
        }
        .sidenav-section-header {
            padding: 8px 16px 4px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            color: var(--mat-sys-on-surface-variant, #64748b);
            letter-spacing: 0.08em;
            font-family: Figtree, sans-serif;
        }
        .sidenav-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 16px 8px 24px;
            text-decoration: none;
            color: var(--mat-sys-on-surface, #1e293b);
            font-size: 14px;
            border-radius: 0 24px 24px 0;
            margin-right: 12px;
            transition: background 0.15s, color 0.15s;
        }
        .sidenav-item:hover {
            background: var(--primary-opacity-08, rgba(110, 51, 255, 0.04));
        }
        .sidenav-item.active {
            background: var(--sat-sys-hyland-purple-container, #e2dfff);
            color: var(--sat-sys-hyland-purple, #6e33ff);
        }
        .sidenav-item mat-icon {
            font-size: 20px;
            width: 20px;
            height: 20px;
            color: inherit;
        }
        .sidenav-item.active mat-icon {
            color: var(--sat-sys-hyland-purple, #6e33ff);
        }
        .sidenav-item-label {
            font-weight: 500;
        }
    `]
})
export class FaceCompareSidenavComponent {}
