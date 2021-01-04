import {Racon} from "./racon";
import {sheets_v4} from "googleapis";
import neo4j from "neo4j-driver";
import Schema$Sheet = sheets_v4.Schema$Sheet;

export class ValidateConsume {

    async validateC4(message: any) {
        const username = message.github.username;
        const password = message.github.password;
        const repository = message.github.repository;
        const organization = message.github.organization;
        const branch = message.github.branch;
        const projectName = message.projectName;
        const workSpaceId = message.structurizr.workSpaceId;
        const apiKey = message.structurizr.apiKey;
        const apiSecret = message.structurizr.secret;
        const excludedPaths = message.excludedPaths;

        const allProjectsSpreadSheetId = '1f5kzY8xQKgR2EAkJ8t9pgepze9vb7SnEvdPkwa1JAGg';

        const neo4jUrl = 'bolt://localhost:7687';
        const neo4jUsername = 'neo4j';
        const neo4jPassword = '123456';
        // const neo4jUrl = 'bolt://3.90.66.148:7687';
        // const neo4jUsername = 'neo4j';
        // const neo4jPassword = '123456';

        const driver = neo4j.driver(neo4jUrl, neo4j.auth.basic(neo4jUsername, neo4jPassword));

        try {
            const racon = new Racon(projectName, driver)
            const spreadsheet = await racon.getAllProjectsSpreadSheet(allProjectsSpreadSheetId);
            const projectExist = await racon.isProjectExist();
            let schemaSheet: Schema$Sheet;
            if (projectExist) {
                schemaSheet = await racon.getSheetId(spreadsheet, projectName);
            } else {
                await racon.cleanup();
                await racon.createProjectSheet(spreadsheet);
                schemaSheet = await racon.getSheetId(spreadsheet, projectName);
                await racon.createProject(projectName, schemaSheet);
            }
            await racon.cloneRepo(username, password, organization, repository, repository, branch);
            await racon.traverseFolders(".", repository);
            const listOfUrls = await racon.fetchUrls(workSpaceId, apiKey, apiSecret);
            await racon.validateUrls(organization, branch, listOfUrls);
            await racon.excludePaths(excludedPaths);
            const pathsReport = await racon.fetchPaths();
            await racon.saveToGoogleSheet(spreadsheet, schemaSheet, pathsReport);
            await racon.cleanRepo(repository);
            console.log(`spreadsheet url => ${spreadsheet.spreadsheetUrl}`);
        } catch (e) {
            console.log(e);
        } finally {
            await driver.close();
        }
    }

}
