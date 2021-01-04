import simpleGit, {SimpleGit} from 'simple-git';
import {Driver} from 'neo4j-driver';
import * as fs from "fs-extra";
import * as path from "path";
import {StructurizrClient} from "structurizr-typescript"
import {google, sheets_v4} from "googleapis";
import Schema$Spreadsheet = sheets_v4.Schema$Spreadsheet;
import Schema$Sheet = sheets_v4.Schema$Sheet;

interface PathReport {
    fullPath: string;
    note: string;
    visited: boolean;
    excluded: boolean;
}

interface ExcludedPath {
    path: string;
    note: string;
}

export class Racon {

    constructor(private projectName: string, private driver: Driver) {
    }

    public async cloneRepo(username: string, password: string, organization: string, repo: string, localPath: string, branch: string): Promise<void> {
        if (fs.existsSync(localPath)) {
            fs.removeSync(localPath);
        }
        const fullRepoPath = `${organization}/${repo}.git`;
        const remote = `https://${username}:${password}@github.com/${fullRepoPath}`;
        const git: SimpleGit = simpleGit();
        await git.clone(remote, localPath, {'--branch': branch});
    }

    public async cleanRepo(localPath: string): Promise<void> {
        if (fs.existsSync(localPath)) {
            fs.removeSync(localPath);
        }
    }

    public async isProjectExist(): Promise<boolean> {
        const session = this.driver.session();
        const result = await session.run(`MATCH(n:\`${this.projectName}\`) RETURN n`);
        const records = result.records;
        await session.close();
        return records.length != 0;
    }

    public async cleanup(): Promise<void> {
        const session = this.driver.session();
        await session.run(`Match (p:\`${this.projectName}\`)<-[:BELONGS_TO]-(f) DETACH DELETE f`);
        await session.close();
    }

    async createProject(projectName: string, schemaSheet: Schema$Sheet | null) {
        if (schemaSheet == null) {
            return;
        }
        const session = this.driver.session();
        await session.run(`
            MERGE (f:\`${projectName}\`)
            RETURN f`);
        await session.close();
    }

    public async traverseFolders(rootPath: string, localPath: string) {
        const fullPath = path.join(rootPath, localPath);
        const folders = this.getDirectoriesRecursive(fullPath);
        await this.saveFolder(localPath, fullPath);
        for (const folder of folders) {
            const subFullPath = path.join(fullPath, folder);
            await this.saveFolder(folder, subFullPath);
            await this.traverseFolders(fullPath, folder);
        }
    }

    public getDirectoriesRecursive(srcPath: string): string[] {
        return this.getDirectories(srcPath);
    }

    private getDirectories(srcPath: string): string[] {
        const dir = fs.readdirSync(srcPath, {withFileTypes: true})
        return dir.filter((dirent: fs.Dirent) => dirent.isDirectory()).map((dirent: fs.Dirent) => dirent.name);
    }

    async saveFolder(folder: string, fullPath: string): Promise<void> {
        if (!folder) {
            return;
        }
        const fullPathEscapedChar = fullPath.replace(/\\/g, '\\\\');
        const session = this.driver.session();
        await session.run(`
            MERGE (f:\`${fullPath}\`)
            ON CREATE SET f.fullPath = '${fullPathEscapedChar}',
            f.visited = false,
            f.excluded = false,
            f.note = 'ERROR'
            RETURN f`);
        await this.attachToProject(fullPath);
        await session.close();
    }

    async attachToProject(fullPath: string) {
        const session = this.driver.session();
        await session.run(`
        Match (p:\`${this.projectName}\`)
        Match (f:\`${fullPath}\`)         
        MERGE (p)<-[:BELONGS_TO]-(f) RETURN p,f`);
        await session.close();
    }

    async fetchUrls(workSpaceId: number, apiKey: string, apiSecret: string) {
        const listOfUrls: string[] = [];
        const structurizrClient = new StructurizrClient(apiKey, apiSecret);
        const workspace = await structurizrClient.getWorkspace(workSpaceId);
        for (let softwareSystem of workspace.model.softwareSystems) {
            if (!softwareSystem.containers) {
                continue;
            }
            for (let container of softwareSystem.containers) {
                if (!container.components) {
                    continue;
                }
                for (let component of container.components) {
                    if (!component.url) {
                        continue;
                    }
                    listOfUrls.push(component.url);
                }
            }
        }
        return listOfUrls;
    }

    public async validateUrls(organization: string, branch: string, listOfUrls: string[]): Promise<void> {
        for (let url of listOfUrls) {
            const fullPathEscapedChar = url.replace('https://', '')
                .replace('github.com/', '')
                .replace(`${organization}/`, "")
                .replace(`tree/${branch}/`, "")
                .replace(/\//g, '\\\\');
            await this.markAsVisited(fullPathEscapedChar);
        }
    }

    private async markAsVisited(folderPath: string): Promise<void> {
        const session = this.driver.session();
        await session.run(`
        MATCH (n)
        WHERE n.fullPath STARTS WITH '${folderPath}'
        SET n.visited = true,
        n.excluded = false,
        n.note = 'exist in the model'
        RETURN n.fullPath, n.visited
        `);
        await session.close();
    }

    async excludePaths(excludedFolders: ExcludedPath[]): Promise<void> {
        for (let excluded of excludedFolders) {
            const fullPathEscapedChar = excluded.path.replace(/\\/g, '\\\\');
            await this.markAsExcluded(fullPathEscapedChar, excluded.note);
        }
    }

    private async markAsExcluded(folderPath: string, note: string): Promise<void> {
        const session = this.driver.session();
        await session.run(`
        MATCH (n)
        WHERE n.fullPath STARTS WITH '${folderPath}'
        SET n.visited = false,
        n.excluded = true,
        n.note = '${note}'
        `);
        await session.close();
    }

    async fetchPaths(): Promise<PathReport[]> {
        const session = this.driver.session();
        const result = await session.run(`MATCH(n) RETURN n.fullPath, n.note, n.visited, n.excluded`);
        const pathsReports: PathReport[] = [];
        const records = result.records;
        for (let record of records) {
            pathsReports.push({
                fullPath: record.get('n.fullPath'),
                note: record.get('n.note'),
                excluded: record.get('n.excluded'),
                visited: record.get('n.visited')
            });
        }
        await session.close();
        return pathsReports;
    }

    async saveToGoogleSheet(spreadsheet: Schema$Spreadsheet, schemaSheet: Schema$Sheet, pathsReports: PathReport[]) {
        const sheets = await this.authorize();
        await this.clearProjectSheetWithValues(sheets, spreadsheet, schemaSheet);
        await this.updateProjectSheetWithValues(sheets, spreadsheet, schemaSheet, pathsReports);
        await this.updateProjectSheetWithFormat(sheets, spreadsheet, schemaSheet, pathsReports);
        return spreadsheet;
    }

    async authorize() {
        const credentials = fs.readJSONSync('credentials.json');
        const {client_secret, client_id, redirect_uris} = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
        const tokenPath = 'token.json';
        if (fs.existsSync(tokenPath)) {
            const token = fs.readJSONSync(tokenPath, {encoding: 'UTF-8'});
            oAuth2Client.setCredentials(token);
            return google.sheets({version: 'v4', auth: oAuth2Client});
        } else {
            throw Error("please issue a token");
        }
    }

    async createProjectSheet(spreadsheet: Schema$Spreadsheet): Promise<void> {
        const sheets = await this.authorize();
        await sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheet.spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: this.projectName
                            }
                        }
                    }]
                }
            }
        );
    }

    async getAllProjectsSpreadSheet(spreadsheetId: string): Promise<Schema$Spreadsheet> {
        const sheets = await this.authorize();
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId,
        });
        return spreadsheet.data;
    }

    async getSheetId(spreadsheet: Schema$Spreadsheet, projectName: string): Promise<Schema$Sheet> {
        const sheets = await this.authorize();
        const ss = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheet.spreadsheetId,
        });
        const schemaSheets = ss.data.sheets;
        if (schemaSheets == null || schemaSheets.length == 0) {
            throw Error("No sheets exist!");
        }
        for (let schemaSheet of schemaSheets) {
            if (schemaSheet != null && schemaSheet.properties?.title == projectName) {
                return schemaSheet;
            }
        }
        throw Error("Can't get sheet id!");
    }

    async clearProjectSheetWithValues(sheets: any, spreadsheet: Schema$Spreadsheet, schemaSheet: Schema$Sheet) {
        await sheets.spreadsheets.values.batchClear({
            spreadsheetId: spreadsheet.spreadsheetId,
            requestBody: {
                ranges: [`${schemaSheet.properties?.title}!A2:A1000`,
                    `${schemaSheet.properties?.title}!B2:B1000`,
                    `${schemaSheet.properties?.title}!C2:C1000`]
            }
        });
    }

    async updateProjectSheetWithValues(sheets: any, spreadsheet: Schema$Spreadsheet, schemaSheet: Schema$Sheet, pathsReports: PathReport[]) {
        const values = this.convertPathsToSheetValues(pathsReports);
        await sheets.spreadsheets.values.update({
            spreadsheetId: spreadsheet.spreadsheetId,
            range: `${schemaSheet.properties?.title}!A1`,
            valueInputOption: 'RAW',
            requestBody: {
                values,
                majorDimension: "COLUMNS"
            }
        });

    }

    async updateProjectSheetWithFormat(sheets: any, spreadsheet: Schema$Spreadsheet, schemaSheet: Schema$Sheet, pathsReports: PathReport[]) {
        const dataRange = {
            sheetId: schemaSheet.properties?.sheetId,
            startRowIndex: 1,
            endRowIndex: pathsReports.length,
            startColumnIndex: 1,
            endColumnIndex: 2,
        };
        const requests = [{
            addConditionalFormatRule: {
                rule: {
                    ranges: [dataRange],
                    booleanRule: {
                        condition: {
                            type: 'TEXT_EQ',
                            values: [{userEnteredValue: 'Valid'}],
                        },
                        format: {
                            backgroundColor: {red: 0.4, green: 1, blue: 0.4},
                        },
                    },
                },
                index: 0,
            },
        }, {
            addConditionalFormatRule: {
                rule: {
                    ranges: [dataRange],
                    booleanRule: {
                        condition: {
                            type: 'TEXT_EQ',
                            values: [{userEnteredValue: 'Excluded'}],
                        },
                        format: {
                            backgroundColor: {red: 0.5, green: 0.5, blue: 0.5},
                        },
                    },
                },
                index: 0,
            },
        }, {
            addConditionalFormatRule: {
                rule: {
                    ranges: [dataRange],
                    booleanRule: {
                        condition: {
                            type: 'TEXT_EQ',
                            values: [{userEnteredValue: 'Invalid'}],
                        },
                        format: {
                            backgroundColor: {red: 1, green: 0.4, blue: 0.4},
                        },
                    },
                },
                index: 0,
            },
        }, {
            repeatCell: {
                range: {
                    sheetId: schemaSheet.properties?.sheetId,
                    startRowIndex: 0,
                    endRowIndex: 1
                },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: {red: 0.9, green: 0.9, blue: 0.9},
                    }
                },
                fields: "userEnteredFormat(backgroundColor)"
            }
        }];

        const filterDataRange = {
            sheetId: schemaSheet.properties?.sheetId,
            startColumnIndex: 0,
            endColumnIndex: 3
        };

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheet.spreadsheetId,
            requestBody: {requests}
        });

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheet.spreadsheetId,
            requestBody: {
                requests: [{
                    addFilterView:
                        {
                            filter: {
                                title: `Excluded Paths ${schemaSheet.properties?.title}`,
                                range: filterDataRange,
                                criteria: {
                                    1: {
                                        condition: {
                                            type: 'TEXT_EQ',
                                            values: [{userEnteredValue: 'Excluded'}],
                                        }
                                    }
                                }
                            },
                        }
                }, {
                    addFilterView:
                        {
                            filter: {
                                title: `Invalid Paths ${schemaSheet.properties?.title}`,
                                range: filterDataRange,
                                criteria: {
                                    1: {
                                        condition: {
                                            type: 'TEXT_EQ',
                                            values: [{userEnteredValue: 'Invalid'}],
                                        }
                                    }
                                }
                            },
                        }
                }, {
                    addFilterView:
                        {
                            filter: {
                                title: `Valid Paths ${schemaSheet.properties?.title}`,
                                range: filterDataRange,
                                criteria: {
                                    1: {
                                        condition: {
                                            type: 'TEXT_EQ',
                                            values: [{userEnteredValue: 'Valid'}],
                                        }
                                    }
                                }
                            },
                        }
                }]
            }
        });
    }

    convertPathsToSheetValues(pathsReports: PathReport[]) {
        let values: string[][] = [];

        values[0] = [];
        values[1] = [];
        values[2] = [];

        values[0][0] = 'Full Path';
        values[1][0] = 'Status';
        values[2][0] = 'Notes';

        for (let i = 0; i < pathsReports.length; i++) {
            values[0][i] = pathsReports[i].fullPath;
        }
        for (let i = 0; i < pathsReports.length; i++) {
            if (pathsReports[i].visited) {
                values[1][i] = 'Valid';
            } else if (pathsReports[i].excluded) {
                values[1][i] = 'Excluded';
            } else {
                values[1][i] = 'Invalid';
            }
        }
        for (let i = 0; i < pathsReports.length; i++) {
            values[2][i] = pathsReports[i].note;
        }
        return values;
    }

}
